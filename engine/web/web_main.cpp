// Web entry points for 3D Pinball: Space Cadet.
//
// In the browser the game is driven from JavaScript instead of owning a main
// loop: the page calls scp_tick() once per requestAnimationFrame with the real
// elapsed time, reads the software-rendered frame straight out of WASM memory
// and presents it with WebGL. Input, audio and UI all live in the page; this
// file is the narrow C API between the two.

#include "pch.h"
#include <emscripten.h>

#include "web_api.h"

#include "control.h"
#include "fullscrn.h"
#include "high_score.h"
#include "midi.h"
#include "nudge.h"
#include "options.h"
#include "pb.h"
#include "render.h"
#include "score.h"
#include "Sound.h"
#include "TPinballTable.h"
#include "translations.h"
#include "winmain.h"

namespace
{
	bool Ready = false;
	bool MusicAvailable = false;
	double MaxStepMs = 1000.0 / 240.0;

	// Values pushed by the page before scp_init(); applied after the option
	// system has initialised itself with defaults.
	struct
	{
		bool Sounds = true;
		int SoundVolume = MIX_MAX_VOLUME;
		bool Stereo = true;
		int Channels = 8;
		bool Music = false;
		int MusicVolume = MIX_MAX_VOLUME;
		int Players = 1;
		int Resolution = -1;
	} Config;

	struct
	{
		bool Any;
		int X0, Y0, X1, Y1;
	} Dirty{};

	struct
	{
		int Seq;
		int Count;
		int Eligible;
		int Demo;
		int Scores[8];
	} GameOver{};

	int32_t State[SCP_STATE_SIZE]{};

	void MarkAllDirty()
	{
		if (!render::vscreen)
			return;
		Dirty = {true, 0, 0, render::vscreen->Width, render::vscreen->Height};
	}

	void PlayerScore(int index, int& lo, int& hi)
	{
		auto table = pb::MainTable;
		lo = hi = 0;
		if (!table || index < 0 || index >= table->PlayerCount)
			return;
		if (index == table->CurrentPlayer)
		{
			lo = table->CurScore;
			hi = table->CurScoreE9;
		}
		else
		{
			lo = table->PlayerScores[index].Score;
			hi = table->PlayerScores[index].ScoreE9Part;
		}
		// The display struct is authoritative for the low part at game end.
		auto display = table->PlayerScores[index].ScoreStruct;
		if (display && display->Score > lo)
			lo = display->Score;
	}

	// Gameplay bindings are fed through synthetic controller "buttons" so the
	// engine's own input path (pb::InputDown/InputUp) runs unchanged.
	constexpr int SyntheticButtonBase = 1000;

	void InstallWebBindings()
	{
		for (auto binding = GameBindings::Min; binding < GameBindings::Max; binding++)
		{
			auto& key = options::Options.Key[~binding];
			for (auto& input : key.Inputs)
				input = GameInput{};
			if (binding <= GameBindings::BottomTableBump)
				key.Inputs[0] = GameInput{InputTypes::GameController, SyntheticButtonBase + ~binding};
		}
	}

	void ApplyAudioConfig()
	{
		auto& o = options::Options;
		o.SoundStereo = Config.Stereo;
		if (o.SoundChannels != Config.Channels)
		{
			o.SoundChannels = Config.Channels;
			if (Ready)
				Sound::SetChannels(Config.Channels);
		}
		o.SoundVolume = Config.SoundVolume;
		if (o.Sounds != Config.Sounds)
		{
			o.Sounds = Config.Sounds;
			if (Ready)
				Sound::Enable(Config.Sounds);
		}
		if (Ready)
			Sound::SetVolume(Config.SoundVolume);

		o.MusicVolume = Config.MusicVolume;
		if (Ready)
			midi::SetVolume(Config.MusicVolume);
		auto wantMusic = Config.Music && (MusicAvailable || !Ready);
		if (o.Music != wantMusic)
		{
			if (Ready)
				options::toggle(Menu1::Music);
			else
				o.Music = wantMusic;
		}
	}
}

// ---------------------------------------------------------------------------
// Hooks called from patched engine code
// ---------------------------------------------------------------------------

FILE* fopenu(const char* path, const char* opt)
{
	auto file = fopen(path, opt);
	if (file || !path)
		return file;

	// Game data comes from Windows, where file names are case-insensitive and
	// the .DAT refers to files in whatever case the installer used. The page
	// stores data in upper case; retry the part below the data root in both
	// cases before giving up.
	std::string full = path;
	auto& root = pb::BasePath;
	size_t start = (!root.empty() && full.compare(0, root.size(), root) == 0) ? root.size() : full.rfind('/') + 1;
	for (int pass = 0; pass < 2; pass++)
	{
		auto candidate = full;
		std::transform(candidate.begin() + static_cast<long>(start), candidate.end(),
		               candidate.begin() + static_cast<long>(start),
		               [pass](unsigned char c) { return pass == 0 ? std::toupper(c) : std::tolower(c); });
		if (candidate != full && (file = fopen(candidate.c_str(), opt)))
			return file;
	}
	return nullptr;
}

void scp_mark_dirty(const gdrv_bitmap8* bmp, int x, int y, int w, int h)
{
	if (bmp != render::vscreen || w <= 0 || h <= 0)
		return;
	auto x1 = x + w, y1 = y + h;
	if (!Dirty.Any)
	{
		Dirty = {true, x, y, x1, y1};
		return;
	}
	Dirty.X0 = std::min(Dirty.X0, x);
	Dirty.Y0 = std::min(Dirty.Y0, y);
	Dirty.X1 = std::max(Dirty.X1, x1);
	Dirty.Y1 = std::max(Dirty.Y1, y1);
}

void scp_on_game_over(bool demo)
{
	auto table = pb::MainTable;
	GameOver.Seq++;
	GameOver.Demo = demo;
	GameOver.Count = table ? std::min(table->PlayerCount, 4) : 0;
	GameOver.Eligible = table && !demo && !table->CheatsUsed;
	for (int i = 0; i < 4; i++)
		PlayerScore(i, GameOver.Scores[i * 2], GameOver.Scores[i * 2 + 1]);
}

EM_JS(void, scp_js_message, (int flags, const char* title, const char* message), {
	var f = Module.onEngineMessage;
	if (f) f(flags, UTF8ToString(title), UTF8ToString(message));
});

void scp_show_message(Uint32 flags, const char* title, const char* message)
{
	scp_js_message(static_cast<int>(flags), title ? title : "", message ? message : "");
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

extern "C" {

EMSCRIPTEN_KEEPALIVE int scp_init(const char* dataPath, int attract)
{
	if (Ready)
		return 0;

	SDL_SetMainReady();
	// No video or audio subsystems: the page presents frames and plays sound.
	if (SDL_Init(SDL_INIT_TIMER | SDL_INIT_EVENTS) < 0)
		return 2;

	ImGui::CreateContext();
	auto& io = ImGui::GetIO();
	winmain::ImIO = &io;
	io.IniFilename = nullptr; // Settings and scores are persisted by the page.

	options::InitPrimary();
	auto& o = options::Options;
	o.Language.V = "en";
	translations::SetCurrentLanguage("en");
	o.ShowMenu = false;
	o.FullScreen = false;
	o.Players = Clamp(Config.Players, 1, 4);
	o.Resolution = Config.Resolution;
	ApplyAudioConfig();
	InstallWebBindings();

	std::vector<const char*> searchPaths{dataPath};
	pb::SelectDatFile(searchPaths);
	options::InitSecondary();

	Sound::Init(true, o.SoundChannels, o.Sounds, o.SoundVolume);
	MusicAvailable = midi::music_init(true, o.MusicVolume);
	if (!MusicAvailable)
		o.Music = false;

	if (pb::init())
	{
		scp_show_message(SDL_MESSAGEBOX_ERROR, "Could not load game data",
		                 "No PINBALL.DAT or CADET.DAT was found in the selected game data.");
		return 1;
	}

	pb::reset_table();
	pb::firsttime_setup();
	Ready = true;

	if (attract)
		pb::toggle_demo();
	else
		pb::replay_level(false);

	MarkAllDirty();
	return 0;
}

// Advance the simulation by one displayed frame. The frame is split into equal
// sub-steps no longer than MaxStepMs, so physics runs at >= the configured
// rate while the ball still moves exactly once per vsync (no judder from a
// fixed-step accumulator beating against the display refresh rate).
EMSCRIPTEN_KEEPALIVE int scp_tick(double frameMs)
{
	if (!Ready || winmain::single_step || !(frameMs > 0))
		return 0;
	frameMs = std::min(frameMs, 100.0);

	auto steps = static_cast<int>(std::ceil(frameMs / MaxStepMs - 1e-6));
	steps = Clamp(steps, 1, 64);
	auto dt = static_cast<float>(frameMs / steps);
	for (int i = 0; i < steps; i++)
	{
		// Only the last sub-step needs to repaint the virtual screen.
		pb::SkipRender = i + 1 < steps;
		pb::frame(dt);
	}
	pb::SkipRender = false;
	return steps;
}

EMSCRIPTEN_KEEPALIVE int32_t* scp_state()
{
	auto& s = State;
	std::fill(std::begin(s), std::end(s), 0);
	s[SCP_READY] = Ready;
	if (!Ready)
		return s;

	auto table = pb::MainTable;
	s[SCP_GAME_MODE] = static_cast<int>(pb::game_mode);
	s[SCP_DEMO] = winmain::DemoActive;
	s[SCP_PAUSED] = winmain::single_step;
	s[SCP_PLAYER_COUNT] = table->PlayerCount;
	s[SCP_CURRENT_PLAYER] = table->CurrentPlayer;
	s[SCP_BALL_NUMBER] = table->BallCount > 0 ? table->MaxBallCount - table->BallCount + 1 : 0;
	s[SCP_MAX_BALLS] = table->MaxBallCount;
	s[SCP_TILT_LOCK] = table->TiltLockFlag;
	s[SCP_CHEATS_USED] = table->CheatsUsed;
	s[SCP_CHEAT_MODE] = pb::cheat_mode;
	s[SCP_FULL_TILT] = pb::FullTiltMode;
	s[SCP_RESOLUTION] = fullscrn::GetResolution();
	s[SCP_MULTIBALL] = table->MultiballCount;
	s[SCP_LAUNCH_ENABLED] = winmain::LaunchBallEnabled;
	s[SCP_NUDGE] = static_cast<int>(std::max(0.0f, nudge::nudge_count) * 1000.0f);
	s[SCP_MUSIC_AVAILABLE] = MusicAvailable;

	s[SCP_SCREEN_PTR] = static_cast<int32_t>(reinterpret_cast<uintptr_t>(render::vscreen->BmpBufPtr1));
	s[SCP_SCREEN_W] = render::vscreen->Width;
	s[SCP_SCREEN_H] = render::vscreen->Height;
	s[SCP_STRIDE] = render::vscreen->Stride;
	s[SCP_TABLE_W] = table->Width;
	s[SCP_OFFSET_X] = render::GetOffsetX();
	s[SCP_OFFSET_Y] = render::GetOffsetY();

	// Dirty rectangle accumulated since the previous call, clipped to screen.
	if (Dirty.Any)
	{
		auto x0 = Clamp(Dirty.X0, 0, render::vscreen->Width), x1 = Clamp(Dirty.X1, 0, render::vscreen->Width);
		auto y0 = Clamp(Dirty.Y0, 0, render::vscreen->Height), y1 = Clamp(Dirty.Y1, 0, render::vscreen->Height);
		if (x1 > x0 && y1 > y0)
		{
			s[SCP_DIRTY] = 1;
			s[SCP_DIRTY_X] = x0;
			s[SCP_DIRTY_Y] = y0;
			s[SCP_DIRTY_W] = x1 - x0;
			s[SCP_DIRTY_H] = y1 - y0;
		}
		Dirty.Any = false;
	}

	for (int i = 0; i < 4; i++)
		PlayerScore(i, s[SCP_SCORES + i * 2], s[SCP_SCORES + i * 2 + 1]);

	s[SCP_GAMEOVER_SEQ] = GameOver.Seq;
	s[SCP_GAMEOVER_COUNT] = GameOver.Count;
	s[SCP_GAMEOVER_ELIGIBLE] = GameOver.Eligible;
	s[SCP_GAMEOVER_DEMO] = GameOver.Demo;
	for (int i = 0; i < 8; i++)
		s[SCP_GAMEOVER_SCORES + i] = GameOver.Scores[i];
	return s;
}

EMSCRIPTEN_KEEPALIVE void scp_invalidate()
{
	MarkAllDirty();
}

// binding: 0..5 = left flipper, right flipper, plunger, bump left/right/bottom
EMSCRIPTEN_KEEPALIVE void scp_input(int binding, int down)
{
	if (!Ready || binding < 0 || binding > ~GameBindings::BottomTableBump)
		return;
	GameInput input{InputTypes::GameController, SyntheticButtonBase + binding};
	if (down)
		pb::InputDown(input);
	else
		pb::InputUp(input);
}

// Raw printable key, used by the game's built-in cheat codes ("hidden test").
EMSCRIPTEN_KEEPALIVE void scp_key(int ch, int down)
{
	if (!Ready || ch <= 0 || ch > 127)
		return;
	GameInput input{InputTypes::Keyboard, ch};
	if (down)
		pb::InputDown(input);
	else
		pb::InputUp(input);
}

EMSCRIPTEN_KEEPALIVE void scp_new_game(int players)
{
	if (!Ready)
		return;
	Config.Players = Clamp(players, 1, 4);
	options::Options.Players = Config.Players;
	winmain::new_game();
}

EMSCRIPTEN_KEEPALIVE void scp_attract()
{
	if (!Ready)
		return;
	winmain::end_pause();
	if (!winmain::DemoActive)
		pb::toggle_demo();
}

EMSCRIPTEN_KEEPALIVE void scp_set_paused(int paused)
{
	if (Ready && static_cast<bool>(paused) != winmain::single_step)
		winmain::pause();
}

EMSCRIPTEN_KEEPALIVE void scp_set_sound(int enabled, int volume, int stereo, int channels)
{
	Config.Sounds = enabled != 0;
	Config.SoundVolume = Clamp(volume, 0, MIX_MAX_VOLUME);
	Config.Stereo = stereo != 0;
	Config.Channels = Clamp(channels, options::MinSoundChannels, options::MaxSoundChannels);
	if (Ready)
		ApplyAudioConfig();
}

EMSCRIPTEN_KEEPALIVE void scp_set_music(int enabled, int volume)
{
	Config.Music = enabled != 0;
	Config.MusicVolume = Clamp(volume, 0, MIX_MAX_VOLUME);
	if (Ready)
		ApplyAudioConfig();
}

EMSCRIPTEN_KEEPALIVE void scp_set_players(int players)
{
	Config.Players = Clamp(players, 1, 4);
	if (Ready)
		options::Options.Players = Config.Players;
}

// -1 = highest available. Only Full Tilt data has more than one resolution;
// takes effect on the next scp_init().
EMSCRIPTEN_KEEPALIVE void scp_set_resolution(int resolution)
{
	Config.Resolution = Clamp(resolution, -1, 2);
}

EMSCRIPTEN_KEEPALIVE void scp_set_physics_rate(int updatesPerSecond)
{
	MaxStepMs = 1000.0 / Clamp(updatesPerSecond, 60, 1000);
}

// Seeds the in-game high score table, which the table itself uses for
// "new high score" effects and the attract-mode score roll.
EMSCRIPTEN_KEEPALIVE void scp_set_high_score(int position, const char* name, int score)
{
	if (position < 0 || position >= 5)
		return;
	auto& entry = high_score::highscore_table[position];
	std::memset(entry.Name, 0, sizeof entry.Name);
	if (name)
		std::strncpy(entry.Name, name, sizeof entry.Name - 1);
	entry.Score = score > 0 ? score : -999;
}

EMSCRIPTEN_KEEPALIVE const char* scp_version()
{
	return winmain::Version;
}

} // extern "C"
