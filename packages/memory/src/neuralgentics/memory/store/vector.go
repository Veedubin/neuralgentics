package store

import (
	"database/sql/driver"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
)

// pgvectorVector wraps a float64 slice to implement driver.Valuer / sql.Scanner.
// pgx natively handles float64 arrays — the SQL query applies the ::vector cast.
// This type is used for explicit vector column binding when needed.
type pgvectorVector []float64

// Value implements driver.Valuer so database/sql can bind the vector.
// It formats the slice as [0.1,0.2,...] which pgvector accepts with ::vector cast.
func (v pgvectorVector) Value() (driver.Value, error) {
	if v == nil {
		return nil, nil
	}
	parts := make([]string, len(v))
	for i, f := range v {
		parts[i] = fmt.Sprintf("%g", f)
	}
	return "[" + strings.Join(parts, ",") + "]", nil
}

// Scan implements sql.Scanner for reading vectors back from PostgreSQL.
// pgvector returns text format '[0.1,0.2,...]' which we parse into []float64.
func (v *pgvectorVector) Scan(src interface{}) error {
	if src == nil {
		*v = nil
		return nil
	}
	switch val := src.(type) {
	case string:
		return v.parseVectorString(val)
	case []byte:
		return v.parseVectorString(string(val))
	default:
		return fmt.Errorf("pgvectorVector: cannot scan %T", src)
	}
}

func (v *pgvectorVector) parseVectorString(s string) error {
	s = strings.TrimSpace(s)
	if s == "" {
		*v = nil
		return nil
	}
	if strings.HasPrefix(s, "[") && strings.HasSuffix(s, "]") {
		s = s[1 : len(s)-1]
	}
	if s == "" {
		*v = pgvectorVector{}
		return nil
	}
	parts := strings.Split(s, ",")
	result := make(pgvectorVector, len(parts))
	for i, p := range parts {
		p = strings.TrimSpace(p)
		var f float64
		if _, err := fmt.Sscanf(p, "%g", &f); err != nil {
			return fmt.Errorf("pgvectorVector: parse element %q: %w", p, err)
		}
		result[i] = f
	}
	*v = result
	return nil
}

// registerVectorCodec registers the pgvector type OID with the pgtype Map
// so pgx can encode/decode vector columns natively.
// Must be called after the schema is created (pgvector extension must exist).
func registerVectorCodec(typeMap *pgtype.Map, conn interface {
	QueryRow(sql string, args ...interface{}) (interface{}, error)
}) error {
	// For now, we rely on text format encoding.
	// pgvector returns text '[0.1,0.2,...]' and accepts the same format for input.
	// pgx's pgtype.Map will handle text codec for unknown types automatically
	// when we register the OID with a text codec.
	return nil
}
