CREATE TABLE "trust_rag_records" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "trust_rag_workspace_kind_idx" ON "trust_rag_records" ("workspace","kind");