package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
)

// leaderboard is the shared high-score table, kept as a small JSON file.
type leaderboard struct {
	path string
	mu   sync.Mutex
	data boardFile
}

type boardFile struct {
	Version int                `json:"version"`
	Tables  map[string][]entry `json:"tables"`
}

type entry struct {
	Name    string `json:"name"`
	Score   int64  `json:"score"`
	Players int    `json:"players"`
	Date    int64  `json:"date"`
}

const (
	keepPerTable = 100
	showPerTable = 25
	maxNameRunes = 20
	maxScore     = 1e13
)

var knownTables = map[string]bool{"3dpb": true, "ft": true}

func openLeaderboard(dir string) (*leaderboard, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	b := &leaderboard{path: filepath.Join(dir, "scores.json"), data: boardFile{Version: 1, Tables: map[string][]entry{}}}
	raw, err := os.ReadFile(b.path)
	switch {
	case err == nil:
		if err := json.Unmarshal(raw, &b.data); err != nil {
			return nil, fmt.Errorf("%s is not valid JSON: %w", b.path, err)
		}
		if b.data.Tables == nil {
			b.data.Tables = map[string][]entry{}
		}
	case errors.Is(err, os.ErrNotExist):
		if err := b.save(); err != nil {
			return nil, fmt.Errorf("%s is not writable: %w", dir, err)
		}
	default:
		return nil, err
	}
	return b, nil
}

// save writes atomically so a crash never leaves a truncated file.
func (b *leaderboard) save() error {
	raw, err := json.MarshalIndent(b.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := b.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, b.path)
}

func (b *leaderboard) top(table string) []entry {
	list := b.data.Tables[table]
	if len(list) > showPerTable {
		list = list[:showPerTable]
	}
	out := make([]entry, len(list))
	copy(out, list)
	return out
}

func (b *leaderboard) handleList(w http.ResponseWriter, r *http.Request) {
	table := r.URL.Query().Get("table")
	if !knownTables[table] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown table"})
		return
	}
	b.mu.Lock()
	scores := b.top(table)
	b.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"scores": scores})
}

func cleanName(s string) string {
	var sb strings.Builder
	space := false
	n := 0
	for _, r := range strings.TrimSpace(s) {
		if unicode.IsControl(r) || r == unicode.ReplacementChar {
			continue
		}
		if unicode.IsSpace(r) {
			space = true
			continue
		}
		if space && sb.Len() > 0 {
			sb.WriteByte(' ')
			n++
		}
		space = false
		if n >= maxNameRunes {
			break
		}
		sb.WriteRune(r)
		n++
	}
	return strings.TrimSpace(sb.String())
}

func (b *leaderboard) handleSubmit(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Table   string  `json:"table"`
		Name    string  `json:"name"`
		Score   float64 `json:"score"`
		Players int     `json:"players"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	name := cleanName(in.Name)
	switch {
	case !knownTables[in.Table]:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown table"})
		return
	case name == "":
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name required"})
		return
	case in.Score < 1 || in.Score > maxScore || in.Score != math.Trunc(in.Score):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid score"})
		return
	}
	players := in.Players
	if players < 1 || players > 4 {
		players = 1
	}
	e := entry{Name: name, Score: int64(in.Score), Players: players, Date: time.Now().UnixMilli()}

	b.mu.Lock()
	defer b.mu.Unlock()
	list := append(b.data.Tables[in.Table], e)
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].Score != list[j].Score {
			return list[i].Score > list[j].Score
		}
		return list[i].Date < list[j].Date
	})
	rank := 0
	for i := range list {
		if list[i] == e {
			rank = i + 1
			break
		}
	}
	if len(list) > keepPerTable {
		list = list[:keepPerTable]
	}
	b.data.Tables[in.Table] = list
	if err := b.save(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not save score"})
		return
	}
	if rank > showPerTable {
		rank = 0
	}
	writeJSON(w, http.StatusOK, map[string]any{"rank": rank, "scores": b.top(in.Table)})
}

// rateLimiter is a fixed-window counter per client.
type rateLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	hits   map[string]*window
}

type window struct {
	start time.Time
	count int
}

func newRateLimiter(limit int, per time.Duration) *rateLimiter {
	return &rateLimiter{limit: limit, window: per, hits: map[string]*window{}}
}

func (l *rateLimiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if len(l.hits) > 10000 {
		for k, v := range l.hits {
			if now.Sub(v.start) > l.window {
				delete(l.hits, k)
			}
		}
	}
	w := l.hits[key]
	if w == nil || now.Sub(w.start) > l.window {
		l.hits[key] = &window{start: now, count: 1}
		return true
	}
	w.count++
	return w.count <= l.limit
}
