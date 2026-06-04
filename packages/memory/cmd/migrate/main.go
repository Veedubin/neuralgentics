// Package main provides the neuralgentics-migrate CLI tool for database
// migration verification and reporting. It connects to a PostgreSQL database
// with pgvector and runs integrity checks against the neuralgentics schema.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	version   = "0.1.0"
	defaultDB = "postgresql://postgres:password@localhost:5434/neuralgentics?sslmode=disable"
	exitOK    = 0
	exitFail  = 1
)

// CheckResult represents the outcome of a single verification check.
type CheckResult struct {
	Name    string `json:"name"`
	Passed  bool   `json:"passed"`
	Details string `json:"details"`
}

// Report represents a complete migration verification report.
type Report struct {
	Timestamp time.Time     `json:"timestamp"`
	Version   string        `json:"version"`
	Checks    []CheckResult `json:"checks"`
	Passed    int           `json:"passed"`
	Failed    int           `json:"failed"`
	Duration  string        `json:"duration"`
}

func main() {
	// Sub-commands
	verifyCmd := flag.NewFlagSet("verify", flag.ExitOnError)
	reportCmd := flag.NewFlagSet("report", flag.ExitOnError)

	// Verify flags
	verifyDBURL := verifyCmd.String("db-url", envOr("DATABASE_URL", defaultDB), "PostgreSQL connection string")
	verifyVerbose := verifyCmd.Bool("verbose", false, "Print detailed check results")

	// Report flags
	reportDBURL := reportCmd.String("db-url", envOr("DATABASE_URL", defaultDB), "PostgreSQL connection string")
	reportOutput := reportCmd.String("output", "", "Output file path (stdout if empty)")
	reportFormat := reportCmd.String("format", "text", "Output format: text or json")

	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "neuralgentics-migrate v%s — data migration verification tool\n\n", version)
		fmt.Fprintf(os.Stderr, "Usage: migrate <command> [flags]\n\n")
		fmt.Fprintf(os.Stderr, "Commands:\n")
		fmt.Fprintf(os.Stderr, "  verify    Run data integrity checks against the database\n")
		fmt.Fprintf(os.Stderr, "  report    Generate a migration status report\n\n")
		fmt.Fprintf(os.Stderr, "Use 'migrate <command> -h' for command-specific help.\n")
		os.Exit(exitFail)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	setupSignalHandler(cancel)

	switch os.Args[1] {
	case "verify":
		verifyCmd.Parse(os.Args[2:])
		runVerify(ctx, *verifyDBURL, *verifyVerbose)
	case "report":
		reportCmd.Parse(os.Args[2:])
		runReport(ctx, *reportDBURL, *reportOutput, *reportFormat)
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", os.Args[1])
		fmt.Fprintf(os.Stderr, "Use 'migrate -h' for usage information.\n")
		os.Exit(exitFail)
	}
}

// runVerify executes all verification checks and exits with code 0 if all pass.
func runVerify(ctx context.Context, dbURL string, verbose bool) {
	checks := runAllChecks(ctx, dbURL)

	allPassed := true
	for _, check := range checks {
		status := "PASS"
		if !check.Passed {
			status = "FAIL"
			allPassed = false
		}
		if verbose || !check.Passed {
			fmt.Printf("[%s] %s: %s\n", status, check.Name, check.Details)
		} else {
			fmt.Printf("[%s] %s\n", status, check.Name)
		}
	}

	passed := countPassed(checks)
	fmt.Printf("\n%d/%d checks passed\n", passed, len(checks))

	if allPassed {
		os.Exit(exitOK)
	}
	os.Exit(exitFail)
}

// runReport generates and outputs a migration status report.
func runReport(ctx context.Context, dbURL, outputPath, format string) {
	if format != "text" && format != "json" {
		fmt.Fprintf(os.Stderr, "unsupported format: %s (use 'text' or 'json')\n", format)
		os.Exit(exitFail)
	}

	checks := runAllChecks(ctx, dbURL)
	report := generateReport(checks)

	// Try to collect database stats
	pool, err := connectDB(ctx, dbURL)
	var stats *dbStats
	if err == nil {
		stats, _ = collectStats(ctx, pool)
		pool.Close()
	}

	var output []byte
	switch format {
	case "json":
		output, err = json.MarshalIndent(struct {
			Report *Report  `json:"report"`
			Stats  *dbStats `json:"stats,omitempty"`
		}{Report: report, Stats: stats}, "", "  ")
		if err != nil {
			log.Fatalf("failed to marshal report: %v", err)
		}
	default:
		output = []byte(formatTextReport(report, stats))
	}

	if outputPath != "" {
		if err := os.WriteFile(outputPath, output, 0o644); err != nil {
			log.Fatalf("failed to write report to %s: %v", outputPath, err)
		}
		fmt.Fprintf(os.Stderr, "Report written to %s\n", outputPath)
	} else {
		fmt.Printf("%s", output)
	}
}

func countPassed(checks []CheckResult) int {
	passed := 0
	for _, c := range checks {
		if c.Passed {
			passed++
		}
	}
	return passed
}

func generateReport(checks []CheckResult) *Report {
	report := &Report{
		Timestamp: time.Now().UTC(),
		Version:   version,
		Checks:    checks,
	}
	for _, c := range checks {
		if c.Passed {
			report.Passed++
		} else {
			report.Failed++
		}
	}
	return report
}

func formatTextReport(report *Report, stats *dbStats) string {
	result := fmt.Sprintf("Neuralgentics Migration Report\n")
	result += fmt.Sprintf("==============================\n")
	result += fmt.Sprintf("Timestamp: %s\n", report.Timestamp.Format(time.RFC3339))
	result += fmt.Sprintf("Version:   %s\n", report.Version)
	result += fmt.Sprintf("Results:   %d passed, %d failed\n\n", report.Passed, report.Failed)

	for _, c := range checks_global {
		status := "PASS"
		if !c.Passed {
			status = "FAIL"
		}
		result += fmt.Sprintf("  [%s] %s\n", status, c.Name)
		if c.Details != "" {
			result += fmt.Sprintf("         %s\n", c.Details)
		}
	}

	if stats != nil {
		result += "\nDatabase Statistics\n"
		result += "───────────────────\n"
		result += fmt.Sprintf("  Active memories:     %d\n", stats.MemoryCount)
		result += fmt.Sprintf("  Archived memories:   %d\n", stats.ArchivedCount)
		result += fmt.Sprintf("  Entities:            %d\n", stats.EntityCount)
		result += fmt.Sprintf("  Peers:               %d\n", stats.PeerCount)
		result += fmt.Sprintf("  Thought chains:      %d\n", stats.ChainCount)
		result += fmt.Sprintf("  Relationships:        %d\n", stats.RelationshipCount)
		result += fmt.Sprintf("  Average trust score:  %.3f\n", stats.AvgTrustScore)
	}

	return result
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func setupSignalHandler(cancel context.CancelFunc) {
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigChan
		fmt.Fprintln(os.Stderr, "\nReceived signal, shutting down...")
		cancel()
	}()
}

func connectDB(ctx context.Context, dbURL string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, fmt.Errorf("parse database URL: %w", err)
	}
	config.MinConns = 1
	config.MaxConns = 5

	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("create connection pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return pool, nil
}

// checks_global is set by runAllChecks; used by formatTextReport.
var checks_global []CheckResult

func runAllChecks(ctx context.Context, dbURL string) []CheckResult {
	pool, err := connectDB(ctx, dbURL)
	if err != nil {
		return []CheckResult{
			{Name: "database_connection", Passed: false, Details: fmt.Sprintf("failed to connect: %v", err)},
		}
	}
	defer pool.Close()

	var checks []CheckResult
	checks = append(checks, verifyVectorDimensions(ctx, pool))
	checks = append(checks, verifyTrustRange(ctx, pool))
	checks = append(checks, verifyForeignKeys(ctx, pool))
	checks = append(checks, verifyContentHashes(ctx, pool))
	checks = append(checks, verifySchemaVersion(ctx, pool))
	checks = append(checks, verifyTableExists(ctx, pool, "memories"))
	checks = append(checks, verifyTableExists(ctx, pool, "peers"))
	checks = append(checks, verifyTableExists(ctx, pool, "entities"))
	checks = append(checks, verifyTableExists(ctx, pool, "memory_relationships"))
	checks = append(checks, verifyTableExists(ctx, pool, "trust_adjustments"))
	checks = append(checks, verifyTableExists(ctx, pool, "thought_chains"))
	checks = append(checks, verifyTableExists(ctx, pool, "thoughts"))
	checks = append(checks, verifyTableExists(ctx, pool, "audit_log"))
	checks = append(checks, verifyExtensionExists(ctx, pool, "vector"))

	checks_global = checks
	return checks
}
