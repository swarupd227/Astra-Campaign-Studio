import { describe, expect, it } from "vitest";
import { Astra } from "../src/app";
import { fixedClock } from "../src/domain/ids";
import type { Actor } from "../src/domain/types";
import { intakeAgent } from "../src/agents/intake";
import {
  InMemoryVectorFabric,
  seedHiltiKnowledge,
  type KnowledgeDoc,
  type KnowledgeFabric,
} from "../src/grounding/knowledgeFabric";
import { PgVectorFabric } from "../src/grounding/pgVectorFabric";
import { createPgliteClient } from "../src/store/sql/client";
import { chunkText, embed, EMBEDDING_DIM } from "../src/grounding/embedding";

const human: Actor = { kind: "human", id: "u1", displayName: "Tester" };

const TE60_DOC: KnowledgeDoc = {
  id: "prod-te60",
  title: "TE 60 rotary hammer spec sheet",
  domain: "product",
  version: "2.0",
  text: "The TE 60 rotary hammer delivers SDS max chiseling power with active vibration reduction. Approved claim: best-in-class drilling speed in concrete under standard test conditions.",
};

/** Contract tests run against BOTH fabric implementations. */
function fabricContract(name: string, make: () => KnowledgeFabric) {
  describe(`${name}`, () => {
    it("retrieves seeded sources with versioned citations and context", async () => {
      const fabric = make();
      const r = await fabric.retrieve("extended runtime temperature management battery platform");
      expect(r.citations.length).toBeGreaterThan(0);
      expect(r.citations[0]!.sourceId).toBe("prod-cordless-22v"); // best match ranks first
      expect(r.citations[0]!.version).toBe("1.2");
      expect(r.context).toContain("Nuron 22V");
    });

    it("returns nothing for a query the fabric is silent on (no generic drift)", async () => {
      const fabric = make();
      const r = await fabric.retrieve("quantum blockchain yoga retreat itinerary");
      expect(r.citations).toHaveLength(0);
      expect(await fabric.isSilentOn("quantum blockchain yoga retreat itinerary")).toBe(true);
    });

    it("ingests a new document and makes it retrievable immediately", async () => {
      const fabric = make();
      const info = await fabric.ingest(TE60_DOC);
      expect(info.chunks).toBeGreaterThanOrEqual(1);
      const r = await fabric.retrieve("TE 60 rotary hammer chiseling vibration");
      expect(r.citations[0]!.sourceId).toBe("prod-te60");
      expect(r.citations[0]!.snippet).toContain("rotary hammer");
    });

    it("re-ingesting the same id replaces the source (new version)", async () => {
      const fabric = make();
      await fabric.ingest(TE60_DOC);
      await fabric.ingest({ ...TE60_DOC, version: "2.1", text: "The TE 60 rotary hammer now ships with a dust removal system." });
      const sources = await fabric.listSources();
      const te60 = sources.filter((s) => s.id === "prod-te60");
      expect(te60).toHaveLength(1); // replaced, not duplicated
      expect(te60[0]!.version).toBe("2.1");
      const r = await fabric.retrieve("TE 60 rotary hammer dust removal");
      expect(r.citations[0]!.version).toBe("2.1");
    });

    it("chunks long documents and retrieves the relevant chunk", async () => {
      const fabric = make();
      const filler = "General installation guidance for anchors and fasteners on commercial sites. ".repeat(12);
      await fabric.ingest({
        id: "prod-long",
        title: "Firestop systems manual",
        domain: "product",
        version: "1.0",
        text: `${filler} The CFS-BL firestop block is intumescent and reusable for cable penetrations.`,
      });
      const sources = await fabric.listSources();
      expect(sources.find((s) => s.id === "prod-long")!.chunks).toBeGreaterThanOrEqual(2);
      const r = await fabric.retrieve("intumescent firestop block cable penetrations");
      expect(r.citations[0]!.sourceId).toBe("prod-long");
      // The snippet comes from the RELEVANT chunk, not just the head of the doc.
      expect(r.citations[0]!.snippet.toLowerCase()).toContain("firestop");
    });
  });
}

fabricContract("InMemoryVectorFabric (hybrid vector + lexical)", () => new InMemoryVectorFabric(seedHiltiKnowledge()));
fabricContract("PgVectorFabric (Postgres + pgvector, embedded)", () =>
  new PgVectorFabric(createPgliteClient(":memory:"), seedHiltiKnowledge()),
);

describe("embedding primitives", () => {
  it("produces normalised fixed-dimension vectors", () => {
    const v = embed("jobsite uptime and cordless runtime");
    expect(v).toHaveLength(EMBEDDING_DIM);
    const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("splits long text on sentence boundaries within the size budget", () => {
    const chunks = chunkText("First sentence here. ".repeat(60), 420);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(420);
  });
});

describe("pgvector fabric persists across instances (shared database)", () => {
  it("a second fabric on the same client sees previously ingested sources", async () => {
    const client = createPgliteClient(":memory:");
    const first = new PgVectorFabric(client, seedHiltiKnowledge());
    await first.ingest(TE60_DOC);
    const second = new PgVectorFabric(client, seedHiltiKnowledge()); // seed skipped: sources exist
    const r = await second.retrieve("TE 60 rotary hammer chiseling");
    expect(r.citations[0]!.sourceId).toBe("prod-te60");
    expect((await second.listSources()).some((s) => s.id === "prod-te60")).toBe(true);
  });
});

describe("ingested knowledge flows into agent grounding (end to end)", () => {
  it("an agent cites a runtime-ingested document", async () => {
    const astra = new Astra({ persistence: "memory", clock: fixedClock("2026-01-01T00:00:00Z"), campaignTokenBudget: 0 });
    await astra.ingestKnowledge(TE60_DOC);
    const id = await astra.createCampaign(
      { objective: "Promote the TE 60 rotary hammer chiseling upgrade", owner: human.id, markets: ["DE"], budget: 1000, currency: "EUR", kpis: ["Leads"] },
      human,
    );
    const result = await astra.orchestrator.runAgent(id, intakeAgent);
    const cited = result.artifact.citations.map((c) => c.sourceId);
    expect(cited).toContain("prod-te60"); // the fresh document grounds the brief
  });
});
