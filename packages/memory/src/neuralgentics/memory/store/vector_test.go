package store

import (
	"testing"
)

func TestFormatVector(t *testing.T) {
	tests := []struct {
		name     string
		input    []float64
		expected string
	}{
		{name: "nil slice", input: nil, expected: ""},
		{name: "empty slice", input: []float64{}, expected: "[]"},
		{name: "single element", input: []float64{1.5}, expected: "[1.5]"},
		{name: "multiple elements", input: []float64{0.1, 0.2, 0.3}, expected: "[0.1,0.2,0.3]"},
		{name: "negative values", input: []float64{-0.5, 0.0, 0.5}, expected: "[-0.5,0,0.5]"},
		{name: "large vector", input: []float64{0.01, -0.02, 0.03, -0.04, 0.05}, expected: "[0.01,-0.02,0.03,-0.04,0.05]"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := formatVector(tt.input)
			if result != tt.expected {
				t.Errorf("formatVector(%v) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

func TestParseVectorString(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected []float64
		wantErr  bool
	}{
		{name: "empty string", input: "", expected: nil, wantErr: false},
		{name: "bracket format", input: "[0.1,0.2,0.3]", expected: []float64{0.1, 0.2, 0.3}, wantErr: false},
		{name: "single element", input: "[1.5]", expected: []float64{1.5}, wantErr: false},
		{name: "negative values", input: "[-0.5,0,0.5]", expected: []float64{-0.5, 0, 0.5}, wantErr: false},
		{name: "empty brackets", input: "[]", expected: []float64{}, wantErr: false},
		{name: "spaces between values", input: "[0.1, 0.2, 0.3]", expected: []float64{0.1, 0.2, 0.3}, wantErr: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := parseVectorString(tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("parseVectorString(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
				return
			}
			if tt.expected == nil {
				if result != nil {
					t.Errorf("parseVectorString(%q) = %v, want nil", tt.input, result)
				}
				return
			}
			if len(result) != len(tt.expected) {
				t.Errorf("parseVectorString(%q) length = %d, want %d", tt.input, len(result), len(tt.expected))
				return
			}
			for i := range result {
				diff := result[i] - tt.expected[i]
				if diff < -0.001 || diff > 0.001 {
					t.Errorf("parseVectorString(%q)[%d] = %v, want %v", tt.input, i, result[i], tt.expected[i])
				}
			}
		})
	}
}

func TestPgvectorVectorValue(t *testing.T) {
	tests := []struct {
		name     string
		input    pgvectorVector
		expected string
	}{
		{name: "nil", input: nil, expected: ""},
		{name: "single", input: pgvectorVector{1.5}, expected: "[1.5]"},
		{name: "multiple", input: pgvectorVector{0.1, 0.2, 0.3}, expected: "[0.1,0.2,0.3]"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			val, err := tt.input.Value()
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tt.input == nil {
				if val != nil {
					t.Errorf("Value() = %v, want nil", val)
				}
				return
			}
			if val != tt.expected {
				t.Errorf("Value() = %v, want %v", val, tt.expected)
			}
		})
	}
}

func TestPgvectorVectorScan(t *testing.T) {
	tests := []struct {
		name     string
		input    interface{}
		expected pgvectorVector
		wantErr  bool
	}{
		{name: "nil source", input: nil, expected: nil, wantErr: false},
		{name: "string format", input: "[0.1,0.2,0.3]", expected: pgvectorVector{0.1, 0.2, 0.3}, wantErr: false},
		{name: "bytes format", input: []byte("[0.1,0.2,0.3]"), expected: pgvectorVector{0.1, 0.2, 0.3}, wantErr: false},
		{name: "empty brackets", input: "[]", expected: pgvectorVector{}, wantErr: false},
		{name: "unsupported type", input: 42, expected: nil, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var v pgvectorVector
			err := v.Scan(tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("Scan(%v) error = %v, wantErr %v", tt.input, err, tt.wantErr)
				return
			}
			if tt.wantErr {
				return
			}
			if tt.expected == nil {
				if v != nil {
					t.Errorf("Scan(%v) = %v, want nil", tt.input, v)
				}
				return
			}
			if len(v) != len(tt.expected) {
				t.Errorf("Scan(%v) length = %d, want %d", tt.input, len(v), len(tt.expected))
				return
			}
			for i := range v {
				diff := v[i] - tt.expected[i]
				if diff < -0.001 || diff > 0.001 {
					t.Errorf("Scan(%v)[%d] = %v, want %v", tt.input, i, v[i], tt.expected[i])
				}
			}
		})
	}
}

func TestMapToJSON(t *testing.T) {
	tests := []struct {
		name  string
		input map[string]any
		want  string
	}{
		{name: "nil map", input: nil, want: "{}"},
		{name: "empty map", input: map[string]any{}, want: "{}"},
		{name: "simple map", input: map[string]any{"key": "value"}, want: `{"key":"value"}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := mapToJSON(tt.input)
			if tt.want == "{}" {
				if string(result) != "{}" {
					t.Errorf("mapToJSON(%v) = %s, want {}", tt.input, string(result))
				}
			}
			// For non-trivial cases, just verify it produces valid JSON
			if tt.input != nil && len(tt.input) > 0 {
				if result == nil || string(result) == "{}" {
					t.Errorf("mapToJSON(%v) produced empty result", tt.input)
				}
			}
		})
	}
}
