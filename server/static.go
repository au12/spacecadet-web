package main

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// staticFiles serves the built front end. Every file is indexed once at
// start-up (content hash for the ETag, which precompressed variants exist),
// so a request costs a map lookup and a sendfile.
type staticFiles struct {
	root  string
	files map[string]*staticFile
}

type staticFile struct {
	path        string
	size        int64
	mod         time.Time
	etag        string
	contentType string
	br, gz      bool
}

var contentTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".json":        "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".wasm":        "application/wasm",
	".svg":         "image/svg+xml",
	".png":         "image/png",
	".woff2":       "font/woff2",
	".woff":        "font/woff",
	".sf2":         "application/octet-stream",
	".sf3":         "application/octet-stream",
	".dls":         "application/octet-stream",
	".map":         "application/json; charset=utf-8",
	".txt":         "text/plain; charset=utf-8",
}

func typeFor(name string) string {
	ext := strings.ToLower(path.Ext(name))
	if t, ok := contentTypes[ext]; ok {
		return t
	}
	if t := mime.TypeByExtension(ext); t != "" {
		return t
	}
	return "application/octet-stream"
}

func newStatic(root string) (*staticFiles, error) {
	s := &staticFiles{root: root, files: map[string]*staticFile{}}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		name := d.Name()
		if strings.HasSuffix(name, ".br") || strings.HasSuffix(name, ".gz") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		urlPath := "/" + filepath.ToSlash(rel)
		f := &staticFile{
			path:        p,
			size:        info.Size(),
			mod:         info.ModTime(),
			contentType: typeFor(name),
		}
		if f.etag, err = hashFile(p); err != nil {
			return err
		}
		_, brErr := os.Stat(p + ".br")
		_, gzErr := os.Stat(p + ".gz")
		f.br, f.gz = brErr == nil, gzErr == nil
		s.files[urlPath] = f
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.files["/index.html"] == nil {
		return nil, fs.ErrNotExist
	}
	return s, nil
}

func hashFile(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)[:8]), nil
}

func (s *staticFiles) Count() int { return len(s.files) }

// acceptsEncoding reports whether the client accepts enc (ignoring q=0).
func acceptsEncoding(header, enc string) bool {
	for _, part := range strings.Split(header, ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if strings.EqualFold(strings.TrimSpace(name), enc) {
			q := strings.ReplaceAll(strings.TrimSpace(params), " ", "")
			return q != "q=0" && q != "q=0.0" && q != "q=0.00" && q != "q=0.000"
		}
	}
	return false
}

func (s *staticFiles) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	p := path.Clean("/" + r.URL.Path)
	if p == "/" {
		p = "/index.html"
	}
	f := s.files[p]
	if f == nil {
		// Unknown page-like paths get the app (it has a single page); missing
		// assets are real 404s so a stale cache never receives HTML as JS.
		if path.Ext(p) != "" || strings.HasPrefix(p, "/assets/") {
			http.NotFound(w, r)
			return
		}
		p, f = "/index.html", s.files["/index.html"]
	}

	h := w.Header()
	h.Set("Content-Type", f.contentType)
	h.Add("Vary", "Accept-Encoding")
	switch {
	case strings.HasPrefix(p, "/assets/"):
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	case strings.HasSuffix(p, ".png") || strings.HasSuffix(p, ".svg"):
		h.Set("Cache-Control", "public, max-age=86400")
	default:
		// index.html, sw.js, manifest: always revalidate (cheap: ETag).
		h.Set("Cache-Control", "no-cache")
	}
	if p == "/sw.js" {
		h.Set("Service-Worker-Allowed", "/")
	}

	file, etag := f.path, f.etag
	ae := r.Header.Get("Accept-Encoding")
	switch {
	case f.br && acceptsEncoding(ae, "br"):
		file, etag = f.path+".br", etag+"-br"
		h.Set("Content-Encoding", "br")
	case f.gz && acceptsEncoding(ae, "gzip"):
		file, etag = f.path+".gz", etag+"-gz"
		h.Set("Content-Encoding", "gzip")
	}
	h.Set("ETag", `"`+etag+`"`)

	fh, err := os.Open(file)
	if err != nil {
		http.Error(w, "unavailable", http.StatusInternalServerError)
		return
	}
	defer fh.Close()
	http.ServeContent(w, r, "", f.mod, fh)
}
