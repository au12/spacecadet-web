// WebAudio-backed implementation of the SDL_mixer subset used by the game.
// See web_mixer.h for the rationale. The JavaScript side lives in
// web/src/audio.js (Module.scpAudio). Every call degrades to a silent no-op
// when the page did not provide an audio backend.

#include "pch.h"
#include <emscripten.h>

// ---------------------------------------------------------------------------
// JavaScript bridges
// ---------------------------------------------------------------------------

EM_JS(int, scp_js_sound_load, (const uint8_t* data, int size), {
	var a = Module.scpAudio;
	return a ? a.loadSound(HEAPU8.slice(data, data + size)) : 0;
});
EM_JS(void, scp_js_sound_free, (int id), {
	var a = Module.scpAudio;
	if (a) a.freeSound(id);
});
EM_JS(int, scp_js_sound_play, (int channel, int id), {
	var a = Module.scpAudio;
	return a ? a.play(channel, id) : -1;
});
EM_JS(void, scp_js_sound_halt, (int channel), {
	var a = Module.scpAudio;
	if (a) a.halt(channel);
});
EM_JS(int, scp_js_sound_playing, (int channel), {
	var a = Module.scpAudio;
	return a ? a.playing(channel) : 0;
});
EM_JS(void, scp_js_sound_position, (int channel, int angle, int distance), {
	var a = Module.scpAudio;
	if (a) a.setPosition(channel, angle, distance);
});
EM_JS(void, scp_js_sound_channels, (int count), {
	var a = Module.scpAudio;
	if (a) a.allocateChannels(count);
});
EM_JS(void, scp_js_sound_volume, (int volume), {
	var a = Module.scpAudio;
	if (a) a.setVolume(volume / 128);
});
EM_JS(int, scp_js_music_load, (const uint8_t* data, int size), {
	var a = Module.scpAudio;
	return a ? a.loadMusic(HEAPU8.slice(data, data + size)) : 0;
});
EM_JS(void, scp_js_music_free, (int id), {
	var a = Module.scpAudio;
	if (a) a.freeMusic(id);
});
EM_JS(int, scp_js_music_play, (int id, int loops), {
	var a = Module.scpAudio;
	return a ? a.playMusic(id, loops) : -1;
});
EM_JS(void, scp_js_music_halt, (), {
	var a = Module.scpAudio;
	if (a) a.haltMusic();
});
EM_JS(void, scp_js_music_volume, (int volume), {
	var a = Module.scpAudio;
	if (a) a.setMusicVolume(volume / 128);
});

// ---------------------------------------------------------------------------
// SDL_mixer API
// ---------------------------------------------------------------------------

namespace
{
	int ChannelCount = 8;
	int ChannelVolume = MIX_MAX_VOLUME;
	int MusicVolume = MIX_MAX_VOLUME;

	bool ReadWholeFile(const char* path, std::vector<uint8_t>& out)
	{
		auto file = fopenu(path, "rb");
		if (!file)
			return false;
		fseek(file, 0, SEEK_END);
		auto size = ftell(file);
		fseek(file, 0, SEEK_SET);
		out.resize(size > 0 ? static_cast<size_t>(size) : 0);
		auto read = out.empty() ? 0 : fread(out.data(), 1, out.size(), file);
		fclose(file);
		return read == out.size();
	}
}

int Mix_Init(int flags) { return flags; }
void Mix_Quit() {}
int Mix_OpenAudio(int, Uint16, int, int) { return 0; }
void Mix_CloseAudio() { scp_js_sound_halt(-1); scp_js_music_halt(); }

int Mix_AllocateChannels(int numchans)
{
	if (numchans >= 0)
	{
		ChannelCount = numchans;
		scp_js_sound_channels(numchans);
	}
	return ChannelCount;
}

int Mix_Volume(int channel, int volume)
{
	auto previous = ChannelVolume;
	if (volume >= 0)
	{
		ChannelVolume = std::min(volume, MIX_MAX_VOLUME);
		// The engine only ever sets the volume of every channel at once.
		scp_js_sound_volume(ChannelVolume);
	}
	return previous;
}

Mix_Chunk* Mix_LoadWAV(const char* file)
{
	std::vector<uint8_t> bytes;
	if (!ReadWholeFile(file, bytes) || bytes.empty())
		return nullptr;
	auto id = scp_js_sound_load(bytes.data(), static_cast<int>(bytes.size()));
	if (id <= 0)
		return nullptr;
	return new Mix_Chunk{id};
}

void Mix_FreeChunk(Mix_Chunk* chunk)
{
	if (!chunk)
		return;
	scp_js_sound_free(chunk->Id);
	delete chunk;
}

int Mix_PlayChannel(int channel, Mix_Chunk* chunk, int)
{
	if (!chunk)
		return -1;
	return scp_js_sound_play(channel, chunk->Id);
}

int Mix_HaltChannel(int channel)
{
	scp_js_sound_halt(channel);
	return 0;
}

// Sound effects are short one-shots, so pausing simply silences them; there is
// nothing worth resuming half a second later.
void Mix_Pause(int channel) { scp_js_sound_halt(channel); }
void Mix_Resume(int) {}

int Mix_Playing(int channel) { return scp_js_sound_playing(channel); }

int Mix_SetPosition(int channel, Sint16 angle, Uint8 distance)
{
	scp_js_sound_position(channel, angle, distance);
	return 1;
}

Mix_Music* Mix_LoadMUS_RW(SDL_RWops* src, int freesrc)
{
	if (!src)
		return nullptr;

	std::vector<uint8_t> bytes;
	auto size = SDL_RWsize(src);
	if (size > 0)
	{
		bytes.resize(static_cast<size_t>(size));
		SDL_RWseek(src, 0, RW_SEEK_SET);
		auto read = SDL_RWread(src, bytes.data(), 1, bytes.size());
		bytes.resize(read);
	}
	if (freesrc)
		SDL_RWclose(src);
	if (bytes.empty())
		return nullptr;

	auto id = scp_js_music_load(bytes.data(), static_cast<int>(bytes.size()));
	if (id <= 0)
		return nullptr;
	return new Mix_Music{id};
}

void Mix_FreeMusic(Mix_Music* music)
{
	if (!music)
		return;
	scp_js_music_free(music->Id);
	delete music;
}

int Mix_PlayMusic(Mix_Music* music, int loops)
{
	if (!music)
		return -1;
	return scp_js_music_play(music->Id, loops) < 0 ? -1 : 0;
}

int Mix_HaltMusic()
{
	scp_js_music_halt();
	return 0;
}

int Mix_VolumeMusic(int volume)
{
	auto previous = MusicVolume;
	if (volume >= 0)
	{
		MusicVolume = std::min(volume, MIX_MAX_VOLUME);
		scp_js_music_volume(MusicVolume);
	}
	return previous;
}
