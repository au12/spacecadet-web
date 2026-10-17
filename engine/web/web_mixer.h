// SDL_mixer-compatible shim for the web build.
//
// The native game mixes audio with SDL_mixer. In the browser that would mean
// software mixing on the main thread through a ScriptProcessorNode, which adds
// ~50 ms of latency and crackles whenever a frame runs long. Instead, every
// Mix_* call used by the engine is forwarded to a small WebAudio backend in the
// page (Module.scpAudio): sound effects become AudioBufferSourceNodes and music
// is rendered by a SoundFont synthesizer running in an AudioWorklet.
//
// Only the subset of the API used by Sound.cpp, midi.cpp and winmain.cpp is
// provided, with the same signatures and semantics as SDL_mixer 2.x.
#pragma once

#include "SDL.h"

#define SDL_MIXER_MAJOR_VERSION 2
#define SDL_MIXER_MINOR_VERSION 99
#define SDL_MIXER_PATCHLEVEL 0

#define MIX_MAX_VOLUME 128
#define MIX_DEFAULT_FREQUENCY 48000
#define MIX_DEFAULT_FORMAT AUDIO_S16SYS

enum MIX_InitFlags
{
	MIX_INIT_FLAC = 0x00000001,
	MIX_INIT_MOD = 0x00000002,
	MIX_INIT_MP3 = 0x00000008,
	MIX_INIT_OGG = 0x00000010,
	MIX_INIT_MID = 0x00000020,
	MIX_INIT_OPUS = 0x00000040,
	MIX_INIT_FLUIDSYNTH = MIX_INIT_MID,
};

struct Mix_Chunk
{
	int Id;
};

struct _Mix_Music
{
	int Id;
};
typedef struct _Mix_Music Mix_Music;

int Mix_Init(int flags);
void Mix_Quit();
int Mix_OpenAudio(int frequency, Uint16 format, int channels, int chunksize);
void Mix_CloseAudio();

int Mix_AllocateChannels(int numchans);
int Mix_Volume(int channel, int volume);
Mix_Chunk* Mix_LoadWAV(const char* file);
void Mix_FreeChunk(Mix_Chunk* chunk);
int Mix_PlayChannel(int channel, Mix_Chunk* chunk, int loops);
int Mix_HaltChannel(int channel);
void Mix_Pause(int channel);
void Mix_Resume(int channel);
int Mix_Playing(int channel);
int Mix_SetPosition(int channel, Sint16 angle, Uint8 distance);

Mix_Music* Mix_LoadMUS_RW(SDL_RWops* src, int freesrc);
void Mix_FreeMusic(Mix_Music* music);
int Mix_PlayMusic(Mix_Music* music, int loops);
int Mix_HaltMusic();
int Mix_VolumeMusic(int volume);
