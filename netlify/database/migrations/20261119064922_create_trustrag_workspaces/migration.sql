CREATE TABLE "datasets" (
	"workspace" text PRIMARY KEY,
	"info" jsonb NOT NULL,
	"passages" jsonb NOT NULL,
	"evaluation" jsonb
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"report" jsonb NOT NULL,
	"cleaned_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queries" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "documents_workspace_idx" ON "documents" ("workspace");--> statement-breakpoint
CREATE INDEX "queries_workspace_idx" ON "queries" ("workspace");