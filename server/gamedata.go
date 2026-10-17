package main

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// gameData finds and serves the original game files from the data volume.
//
// Any folder below DATA_DIR that holds PINBALL.DAT (3D Pinball for Windows)
// or CADET.DAT / DEMO.DAT (Full Tilt! Pinball) becomes a playable table.
// Sound banks (*.dls, *.sf2, *.sf3; typically Windows' gm.dls) are offered
// for music. Only discovered files are reachable, so nothing else in the
// volume is ever exposed.
type gameData struct {
	dir string

	mu       sync.Mutex
	snap     *dataSnapshot
	scanned  time.Time
	gzCache  map[string][]byte
	gzCached int
}

type dataSnapshot struct {
	Tables []*table          `json:"tables"`
	Banks  []*bank           `json:"banks"`
	files  map[string]string // "<id>/<lower rel>" -> absolute path
}

type table struct {
	ID    string      `json:"id"`
	Kind  string      `json:"kind"`
	Name  string      `json:"name"`
	Dir   string      `json:"-"`
	Files []*dataFile `json:"files"`
}

type dataFile struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
	URL  string `json:"url"`
}

type bank struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	URL  string `json:"url"`
}

const (
	scanEvery    = 10 * time.Second
	maxScanDepth = 6
	maxScanFiles = 20000
	gzCacheLimit = 64 << 20
)

var markers = map[string]string{"PINBALL.DAT": "3dpb", "CADET.DAT": "ft", "DEMO.DAT": "ft"}

func newGameData(dir string) *gameData {
	return &gameData{dir: dir, gzCache: map[string][]byte{}}
}

func isGameFile(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".dat", ".wav", ".mid", ".mds":
		return true
	}
	return false
}

func isBank(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".dls", ".sf2", ".sf3":
		return true
	}
	return false
}

// Snapshot returns the current view of the data volume, rescanning if stale.
func (g *gameData) Snapshot() *dataSnapshot {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.snap == nil || time.Since(g.scanned) > scanEvery {
		g.snap = g.scan()
		g.scanned = time.Now()
	}
	return g.snap
}

func fileVersion(info fs.FileInfo) string {
	return fmt.Sprintf("%x-%x", info.Size(), info.ModTime().Unix())
}

func (g *gameData) scan() *dataSnapshot {
	snap := &dataSnapshot{Tables: []*table{}, Banks: []*bank{}, files: map[string]string{}}
	root, err := filepath.Abs(g.dir)
	if err != nil {
		return snap
	}
	type found struct{ dir, kind, marker string }
	var roots []found
	var banks []string
	seen := 0
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		if d.IsDir() {
			if rel != "." && (strings.HasPrefix(d.Name(), ".") || strings.Count(rel, string(filepath.Separator)) >= maxScanDepth) {
				return filepath.SkipDir
			}
			return nil
		}
		if seen++; seen > maxScanFiles {
			return filepath.SkipAll
		}
		upper := strings.ToUpper(d.Name())
		if kind, ok := markers[upper]; ok {
			roots = append(roots, found{filepath.Dir(p), kind, upper})
		} else if isBank(d.Name()) {
			banks = append(banks, p)
		}
		return nil
	})

	// One table per folder; a real CADET.DAT wins over the Full Tilt demo.
	byDir := map[string]found{}
	for _, f := range roots {
		if prev, ok := byDir[f.dir]; !ok || prev.marker == "DEMO.DAT" {
			byDir[f.dir] = f
		}
	}
	dirs := make([]string, 0, len(byDir))
	for d := range byDir {
		dirs = append(dirs, d)
	}
	sort.Strings(dirs)

	used := map[string]int{}
	for _, dir := range dirs {
		f := byDir[dir]
		id := f.kind
		if used[f.kind]++; used[f.kind] > 1 {
			id = fmt.Sprintf("%s-%d", f.kind, used[f.kind])
		}
		t := &table{ID: id, Kind: f.kind, Dir: dir, Name: filepath.Base(dir), Files: []*dataFile{}}
		g.addFiles(snap, t, dir, "")
		if entries, err := os.ReadDir(dir); err == nil {
			for _, e := range entries {
				if e.IsDir() && strings.EqualFold(e.Name(), "sound") {
					g.addFiles(snap, t, filepath.Join(dir, e.Name()), "SOUND/")
				}
			}
		}
		snap.Tables = append(snap.Tables, t)
	}

	names := map[string]int{}
	for _, p := range banks {
		info, err := os.Stat(p)
		if err != nil || info.Size() < 100_000 {
			continue
		}
		name := filepath.Base(p)
		if names[strings.ToLower(name)]++; names[strings.ToLower(name)] > 1 {
			ext := filepath.Ext(name)
			name = fmt.Sprintf("%s-%d%s", strings.TrimSuffix(name, ext), names[strings.ToLower(filepath.Base(p))], ext)
		}
		key := "_banks/" + strings.ToLower(name)
		snap.files[key] = p
		snap.Banks = append(snap.Banks, &bank{
			Name: name,
			Size: info.Size(),
			URL:  "data/_banks/" + url.PathEscape(name) + "?v=" + fileVersion(info),
		})
	}
	return snap
}

func (g *gameData) addFiles(snap *dataSnapshot, t *table, dir, prefix string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() || !isGameFile(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		rel := prefix + e.Name()
		snap.files[t.ID+"/"+strings.ToLower(rel)] = filepath.Join(dir, e.Name())
		t.Files = append(t.Files, &dataFile{
			Path: rel,
			Size: info.Size(),
			URL:  "data/" + t.ID + "/" + (&url.URL{Path: rel}).EscapedPath() + "?v=" + fileVersion(info),
		})
	}
}

func (g *gameData) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	key := strings.ToLower(path.Clean("/" + r.URL.Path))[1:]
	snap := g.Snapshot()
	file, ok := snap.files[key]
	if !ok {
		http.NotFound(w, r)
		return
	}
	info, err := os.Stat(file)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	etag := `"` + fileVersion(info) + `"`
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Add("Vary", "Accept-Encoding")
	if r.URL.Query().Get("v") == fileVersion(info) {
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		h.Set("Cache-Control", "no-cache")
	}

	// Table files (DAT, WAV) shrink by roughly half with gzip; keep the
	// compressed bytes in memory since they never change between scans.
	if !strings.HasPrefix(key, "_banks/") && r.Header.Get("Range") == "" && acceptsEncoding(r.Header.Get("Accept-Encoding"), "gzip") {
		if body := g.gzipped(file, info); body != nil {
			h.Set("Content-Encoding", "gzip")
			h.Set("ETag", strings.TrimSuffix(etag, `"`)+`-gz"`)
			http.ServeContent(w, r, "", info.ModTime(), bytes.NewReader(body))
			return
		}
	}
	h.Set("ETag", etag)
	f, err := os.Open(file)
	if err != nil {
		http.Error(w, "unavailable", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	http.ServeContent(w, r, "", info.ModTime(), f)
}

func (g *gameData) gzipped(file string, info fs.FileInfo) []byte {
	key := file + "|" + fileVersion(info)
	g.mu.Lock()
	body, ok := g.gzCache[key]
	g.mu.Unlock()
	if ok {
		return body
	}
	if info.Size() > 32<<20 {
		return nil
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	_, _ = zw.Write(raw)
	_ = zw.Close()
	body = buf.Bytes()
	if len(body) > len(raw)*9/10 {
		body = nil // not worth it; remember that too
	}
	g.mu.Lock()
	if g.gzCached+len(body) <= gzCacheLimit {
		g.gzCache[key] = body
		g.gzCached += len(body)
	}
	g.mu.Unlock()
	return body
}
