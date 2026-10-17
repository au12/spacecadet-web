// Shared between the engine patches and web_main.cpp.
// The SCP_* state indices are mirrored in web/src/engine.js - keep in sync.
#pragma once

struct gdrv_bitmap8;

// Records a write to a bitmap; only writes to the virtual screen are tracked.
void scp_mark_dirty(const gdrv_bitmap8* bmp, int x, int y, int w, int h);
// Called from pb::end_game.
void scp_on_game_over(bool demo);
// Replaces SDL message boxes with an in-page notification.
void scp_show_message(Uint32 flags, const char* title, const char* message);

enum ScpState
{
	SCP_READY = 0,
	SCP_GAME_MODE,
	SCP_DEMO,
	SCP_PAUSED,
	SCP_PLAYER_COUNT,
	SCP_CURRENT_PLAYER,
	SCP_BALL_NUMBER,
	SCP_MAX_BALLS,
	SCP_TILT_LOCK,
	SCP_CHEATS_USED,
	SCP_CHEAT_MODE,
	SCP_FULL_TILT,
	SCP_RESOLUTION,
	SCP_MULTIBALL,
	SCP_LAUNCH_ENABLED,
	SCP_NUDGE,
	SCP_MUSIC_AVAILABLE,
	SCP_SCREEN_PTR,
	SCP_SCREEN_W,
	SCP_SCREEN_H,
	SCP_STRIDE,
	SCP_TABLE_W,
	SCP_OFFSET_X,
	SCP_OFFSET_Y,
	SCP_DIRTY,
	SCP_DIRTY_X,
	SCP_DIRTY_Y,
	SCP_DIRTY_W,
	SCP_DIRTY_H,
	SCP_SCORES,               // 4 x (low, e9) pairs
	SCP_GAMEOVER_SEQ = SCP_SCORES + 8,
	SCP_GAMEOVER_COUNT,
	SCP_GAMEOVER_ELIGIBLE,
	SCP_GAMEOVER_DEMO,
	SCP_GAMEOVER_SCORES,      // 4 x (low, e9) pairs
	SCP_STATE_SIZE = SCP_GAMEOVER_SCORES + 8,
};
