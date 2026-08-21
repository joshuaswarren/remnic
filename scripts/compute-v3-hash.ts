import { generateH6BenchmarkDataset, computeH6InventoryHash } from "../packages/bench/src/index.ts";

async function main() {
  const dataset = await generateH6BenchmarkDataset(81);
  const { inventoryHash, ...rest } = dataset;
  const computed = computeH6InventoryHash(rest);
  console.log(computed);
}

main().catch(console.error);
