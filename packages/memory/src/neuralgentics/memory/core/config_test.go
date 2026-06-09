package core

import (
	"os"
	"testing"
)

// saveEnv saves the current values of the given env vars and returns a
// restore function that callers must defer.
func saveEnv(keys ...string) func() {
	orig := make(map[string]string, len(keys))
	for _, k := range keys {
		orig[k] = os.Getenv(k)
	}
	return func() {
		for _, k := range keys {
			v, ok := orig[k]
			if !ok {
				os.Unsetenv(k)
			} else {
				os.Setenv(k, v)
			}
		}
	}
}

func TestResolveDatabaseURL_PrefersNeuralgentics(t *testing.T) {
	defer saveEnv("NEURALGENTICS_DB_URL", "MEMINI_DB_URL")()

	os.Unsetenv("NEURALGENTICS_DB_URL")
	os.Unsetenv("MEMINI_DB_URL")

	os.Setenv("NEURALGENTICS_DB_URL", "postgresql://new:5432/db")
	os.Setenv("MEMINI_DB_URL", "postgresql://old:5432/db")

	got := ResolveDatabaseURL()
	if got != "postgresql://new:5432/db" {
		t.Errorf("ResolveDatabaseURL() = %q, want %q", got, "postgresql://new:5432/db")
	}
}

func TestResolveDatabaseURL_FallsBackToMemini(t *testing.T) {
	defer saveEnv("NEURALGENTICS_DB_URL", "MEMINI_DB_URL")()

	os.Unsetenv("NEURALGENTICS_DB_URL")
	os.Unsetenv("MEMINI_DB_URL")

	os.Setenv("MEMINI_DB_URL", "postgresql://legacy:5432/db")

	got := ResolveDatabaseURL()
	if got != "postgresql://legacy:5432/db" {
		t.Errorf("ResolveDatabaseURL() = %q, want %q", got, "postgresql://legacy:5432/db")
	}
}

func TestResolveDatabaseURL_EmptyWhenNeitherSet(t *testing.T) {
	defer saveEnv("NEURALGENTICS_DB_URL", "MEMINI_DB_URL")()

	os.Unsetenv("NEURALGENTICS_DB_URL")
	os.Unsetenv("MEMINI_DB_URL")

	got := ResolveDatabaseURL()
	if got != "" {
		t.Errorf("ResolveDatabaseURL() = %q, want empty string", got)
	}
}

func TestLoadConfigFromEnv_UsesResolvedURL(t *testing.T) {
	defer saveEnv("NEURALGENTICS_DB_URL", "MEMINI_DB_URL")()

	os.Unsetenv("MEMINI_DB_URL")
	os.Setenv("NEURALGENTICS_DB_URL", "postgresql://test:5432/testdb")

	cfg := LoadConfigFromEnv()
	if cfg.DatabaseURL != "postgresql://test:5432/testdb" {
		t.Errorf("LoadConfigFromEnv().DatabaseURL = %q, want %q", cfg.DatabaseURL, "postgresql://test:5432/testdb")
	}
}

func TestLoadConfigFromEnv_FallsBackToMemini(t *testing.T) {
	defer saveEnv("NEURALGENTICS_DB_URL", "MEMINI_DB_URL")()

	os.Unsetenv("NEURALGENTICS_DB_URL")
	os.Setenv("MEMINI_DB_URL", "postgresql://legacy:5432/db")

	cfg := LoadConfigFromEnv()
	if cfg.DatabaseURL != "postgresql://legacy:5432/db" {
		t.Errorf("LoadConfigFromEnv().DatabaseURL = %q, want %q", cfg.DatabaseURL, "postgresql://legacy:5432/db")
	}
}

func TestErrMissingDatabaseURL_ContainsBothNames(t *testing.T) {
	msg := ErrMissingDatabaseURL.Error()
	if !contains(msg, "NEURALGENTICS_DB_URL") {
		t.Errorf("ErrMissingDatabaseURL does not mention NEURALGENTICS_DB_URL: %q", msg)
	}
	if !contains(msg, "MEMINI_DB_URL") {
		t.Errorf("ErrMissingDatabaseURL does not mention MEMINI_DB_URL: %q", msg)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 ||
		(len(s) > 0 && len(sub) > 0 && stringContains(s, sub)))
}

func stringContains(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
