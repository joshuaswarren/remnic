import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EXPECTED_STATUS_SEQUENCE,
  ExpectedPublicCardsFixtureSchema,
  SourceMemoriesFixtureSchema,
  SupportPassportReceiptSchema,
  computeFixtureHash,
  computeResponseHashChain,
  receiptStatusSequence,
} from "./receipt-schema.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

function parseArgs(argv) {
  const result = { requireOpenAi: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--require-openai") {
      result.requireOpenAi = true;
      continue;
    }
    if (arg === "--receipt") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--receipt requires a file");
      result.receiptPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (!result.receiptPath) throw new Error("--receipt requires a file");
  return result;
}

async function readJson(filePath) {
  const value = JSON.parse(await readFile(filePath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value;
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
}

function assertNoPrivateFixtureText(receipt, sourceMemories, expectedPublicCards) {
  const serialized = JSON.stringify(receipt);
  const privateText = [
    ...sourceMemories.memories.map((memory) => memory.content),
    ...expectedPublicCards.cards.flatMap((card) => [card.title, card.statement]),
    expectedPublicCards.question,
  ];
  for (const value of privateText) {
    if (serialized.includes(value)) throw new Error("The receipt contains private fixture text");
  }
}

export async function verifyReceipt(options) {
  const receipt = SupportPassportReceiptSchema.parse(await readJson(path.resolve(options.receiptPath)));
  const sourceMemories = SourceMemoriesFixtureSchema.parse(
    await readJson(path.join(repoRoot, "fixtures/support-passport/source-memories.json"))
  );
  const expectedPublicCards = ExpectedPublicCardsFixtureSchema.parse(
    await readJson(path.join(repoRoot, "fixtures/support-passport/expected-public-cards.json"))
  );

  assertEqual(
    receipt.fixtureHash,
    computeFixtureHash(sourceMemories, expectedPublicCards),
    "The receipt fixture hash does not match the repository fixtures"
  );
  assertEqual(receipt.httpStatusSequence, EXPECTED_STATUS_SEQUENCE, "The receipt status sequence is invalid");
  assertEqual(
    receiptStatusSequence(receipt.responses),
    EXPECTED_STATUS_SEQUENCE,
    "The hashed response statuses are invalid"
  );
  assertEqual(
    receipt.responseHashChain,
    computeResponseHashChain(receipt.responses),
    "The response hash chain is invalid"
  );
  if (receipt.responses.helperRead.bodySha256 === receipt.responses.deniedRead.bodySha256) {
    throw new Error("The successful and denied helper reads must have different body hashes");
  }
  if (receipt.cardRevisions.drafted.includes(receipt.cardRevisions.approved[0].revision)) {
    throw new Error("The approved revision must differ from every model draft revision");
  }
  assertNoPrivateFixtureText(receipt, sourceMemories, expectedPublicCards);

  if (options.requireOpenAi) {
    for (const call of Object.values(receipt.modelCalls)) {
      if (call.route !== "direct" || call.transport !== "openai-responses") {
        throw new Error("The receipt does not prove the direct OpenAI Responses route");
      }
      if (Object.values(call.usage).some((count) => count === null)) {
        throw new Error("The OpenAI proof requires complete token counts");
      }
    }
  }

  return receipt;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const receipt = await verifyReceipt(options);
  console.log(`Verified support passport receipt for commit ${receipt.commitSha}.`);
  console.log(`Verified model routes: ${receipt.modelCalls.draft.route}, ${receipt.modelCalls.answer.route}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Receipt verification failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
