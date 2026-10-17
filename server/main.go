// Command spacecadet serves the browser build of 3D Pinball: Space Cadet.
//
// It hands out the precompressed front end, discovers the original game data
// in a mounted folder, and keeps a shared high-score table. It is a single
// static binary with no dependencies outside the Go standard library, so the
// container image can be built FROM scratch.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var version = "dev"

type config struct {
	Addr        string
	WebRoot     string
	DataDir     string
	StateDir    string
	Leaderboard bool
	TrustProxy  bool
	LogRequests bool
	PUID, PGID  int
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

func envInt(key string, def int) int {
	v, err := strconv.Atoi(env(key, ""))
	if err != nil {
		return def
	}
	return v
}

func loadConfig() config {
	port := env("PORT", "8080")
	return config{
		Addr:        env("LISTEN", ":"+port),
		WebRoot:     env("WEB_ROOT", "/www"),
		DataDir:     env("DATA_DIR", "/data"),
		StateDir:    env("STATE_DIR", "/config"),
		Leaderboard: envBool("LEADERBOARD", true),
		TrustProxy:  envBool("TRUST_PROXY", false),
		LogRequests: envBool("LOG_REQUESTS", false),
		PUID:        envInt("PUID", 1000),
		PGID:        envInt("PGID", 1000),
	}
}

func main() {
	health := flag.Bool("healthcheck", false, "probe the running server and exit 0 when healthy")
	flag.Parse()
	cfg := loadConfig()

	if *health {
		os.Exit(healthcheck(cfg))
	}

	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("spacecadet: ")

	if err := dropPrivileges(cfg); err != nil {
		log.Printf("warning: %v", err)
	}

	static, err := newStatic(cfg.WebRoot)
	if err != nil {
		log.Fatalf("web root %s: %v", cfg.WebRoot, err)
	}
	data := newGameData(cfg.DataDir)
	var board *leaderboard
	if cfg.Leaderboard {
		board, err = openLeaderboard(cfg.StateDir)
		if err != nil {
			log.Printf("leaderboard disabled: %v", err)
			board = nil
		}
	}

	tables := data.Snapshot()
	log.Printf("version %s, %d web files, %d table(s) and %d sound bank(s) in %s, leaderboard %v",
		version, static.Count(), len(tables.Tables), len(tables.Banks), cfg.DataDir, board != nil)
	for _, t := range tables.Tables {
		log.Printf("  table %s: %s (%d files)", t.ID, t.Dir, len(t.Files))
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": version})
	})
	mux.HandleFunc("GET /api/tables", func(w http.ResponseWriter, r *http.Request) {
		snap := data.Snapshot()
		writeJSON(w, http.StatusOK, map[string]any{
			"tables":      snap.Tables,
			"banks":       snap.Banks,
			"leaderboard": board != nil,
			"version":     version,
		})
	})
	if board != nil {
		limiter := newRateLimiter(12, time.Minute)
		mux.HandleFunc("GET /api/scores", board.handleList)
		mux.HandleFunc("POST /api/scores", func(w http.ResponseWriter, r *http.Request) {
			if !limiter.Allow(clientIP(r, cfg.TrustProxy)) {
				writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many scores, slow down"})
				return
			}
			board.handleSubmit(w, r)
		})
	}
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	})
	mux.Handle("GET /data/", http.StripPrefix("/data/", data))
	mux.Handle("/", static)

	var handler http.Handler = securityHeaders(mux)
	if cfg.LogRequests {
		handler = logRequests(handler)
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()

	log.Printf("listening on %s", cfg.Addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func healthcheck(cfg config) int {
	addr := cfg.Addr
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	client := http.Client{Timeout: 3 * time.Second}
	res, err := client.Get("http://" + addr + "/api/health")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

// dropPrivileges switches from root to PUID:PGID after making sure the state
// directory is writable by that user (the linuxserver.io convention, so bind
// mounts on Unraid and friends just work).
func dropPrivileges(cfg config) error {
	if os.Getuid() != 0 || cfg.PUID == 0 {
		return nil
	}
	if err := os.MkdirAll(cfg.StateDir, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", cfg.StateDir, err)
	}
	_ = os.Chown(cfg.StateDir, cfg.PUID, cfg.PGID)
	if entries, err := os.ReadDir(cfg.StateDir); err == nil {
		for _, e := range entries {
			_ = os.Lchown(cfg.StateDir+"/"+e.Name(), cfg.PUID, cfg.PGID)
		}
	}
	if err := syscall.Setgroups([]int{}); err != nil {
		return fmt.Errorf("setgroups: %w", err)
	}
	if err := syscall.Setgid(cfg.PGID); err != nil {
		return fmt.Errorf("setgid %d: %w", cfg.PGID, err)
	}
	if err := syscall.Setuid(cfg.PUID); err != nil {
		return fmt.Errorf("setuid %d: %w", cfg.PUID, err)
	}
	log.Printf("running as %d:%d", cfg.PUID, cfg.PGID)
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			return strings.TrimSpace(strings.Split(xff, ",")[0])
		}
		if xr := r.Header.Get("X-Real-IP"); xr != "" {
			return strings.TrimSpace(xr)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob:; worker-src 'self' blob:; " +
	"font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("Content-Security-Policy", csp)
		h.Set("Permissions-Policy", "gamepad=(self), fullscreen=(self), screen-wake-lock=(self)")
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	n, err := s.ResponseWriter.Write(b)
	s.bytes += n
	return n, err
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		log.Printf("%s %s %d %dB %s", r.Method, r.URL.Path, rec.status, rec.bytes, time.Since(start).Round(time.Microsecond))
	})
}
