import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  allocateHolderPool,
  buildDistributionCommitment,
} from "@cheap/protocol";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
} from "viem";

const root = resolve(import.meta.dirname, "..");
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const decimalPattern = /^(0|[1-9][0-9]*)$/;
const hexDataPattern = /^0x(?:[0-9a-fA-F]{2})*$/;
const distributorAbi = parseAbi([
  "function createDrop(bytes32 dropId, bytes32 allocationRoot, bytes32 batchesRoot, uint256 totalAmount, uint32 expectedBatches)",
  "function distributeBatch(bytes32 dropId, uint256 batchIndex, address[] recipients, uint256[] amounts, bytes32[] proof)",
  "function finalizeDrop(bytes32 dropId)",
]);
const assetContextParameters = parseAbiParameters(
  "uint256 chainId, address token, address distributor, bytes32 dropId",
);
const snapshotParameters = parseAbiParameters(
  "bytes32 dropId, address[] holders, uint256[] minimumBalances, uint256[] streaks, bool[] exclusions",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function decimal(value, field) {
  assert(
    typeof value === "string" && decimalPattern.test(value),
    `${field} must be an unsigned decimal string`,
  );
  return BigInt(value);
}

function address(value, field) {
  assert(
    typeof value === "string" && addressPattern.test(value),
    `${field} must be an EVM address`,
  );
  assert(!/^0x0{40}$/i.test(value), `${field} must not be the zero address`);
  assert(getAddress(value) === value, `${field} must use its canonical checksum`);
}

function bytes32(value, field) {
  assert(
    typeof value === "string" && bytes32Pattern.test(value),
    `${field} must be 32-byte hex`,
  );
}

function sameHex(actual, expected, field) {
  bytes32(actual, field);
  assert(actual.toLowerCase() === expected.toLowerCase(), `${field} does not reproduce`);
}

function sameHexArray(actual, expected, field) {
  assert(Array.isArray(actual), `${field} must be an array`);
  assert(actual.length === expected.length, `${field} length does not reproduce`);
  for (const [index, value] of actual.entries()) {
    sameHex(value, expected[index], `${field}[${index}]`);
  }
}

function transaction(value, field, distributor, expectedData) {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `${field} must be an object`,
  );
  address(value.to, `${field}.to`);
  assert(
    value.to.toLowerCase() === distributor.toLowerCase(),
    `${field}.to must be the artifact distributor`,
  );
  assert(value.value === "0", `${field}.value must be zero`);
  assert(
    typeof value.data === "string" && hexDataPattern.test(value.data),
    `${field}.data must be even-length hex`,
  );
  assert(
    value.data.toLowerCase() === expectedData.toLowerCase(),
    `${field}.data does not reproduce`,
  );
}

async function jsonFiles(directory) {
  const base = resolve(root, directory);
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
    }
  }
  await walk(base);
  return files.sort();
}

function validateDrop(drop, file) {
  const at = (field) => `${file}: ${field}`;
  assert(
    drop && typeof drop === "object" && !Array.isArray(drop),
    at("artifact must be an object"),
  );
  assert(drop.schemaVersion === 2, at("schemaVersion must be 2"));
  assert(drop.chainId === 4663, at("chainId must be Robinhood Chain 4663"));
  bytes32(drop.dropId, at("dropId"));
  bytes32(drop.assetContextHash, at("assetContextHash"));
  bytes32(drop.holderSnapshotHash, at("holderSnapshotHash"));
  bytes32(drop.allocationRoot, at("allocationRoot"));
  bytes32(drop.batchesRoot, at("batchesRoot"));

  const asset = drop.rewardAsset;
  assert(asset && typeof asset === "object", at("rewardAsset must be an object"));
  address(asset.tokenAddress, at("rewardAsset.tokenAddress"));
  address(asset.distributorAddress, at("rewardAsset.distributorAddress"));
  assert(
    typeof asset.symbol === "string" && /^[A-Z0-9._-]{1,16}$/.test(asset.symbol),
    at("rewardAsset.symbol is invalid"),
  );
  assert(
    typeof asset.name === "string" && asset.name.length > 0 && asset.name.length <= 120,
    at("rewardAsset.name is invalid"),
  );
  assert(
    Number.isInteger(asset.decimals) && asset.decimals >= 0 && asset.decimals <= 36,
    at("rewardAsset.decimals is invalid"),
  );
  const expectedAssetContextHash = keccak256(
    encodeAbiParameters(assetContextParameters, [
      4663n,
      asset.tokenAddress,
      asset.distributorAddress,
      drop.dropId,
    ]),
  );
  sameHex(drop.assetContextHash, expectedAssetContextHash, at("assetContextHash"));

  assert(
    Array.isArray(drop.holderSnapshot) && drop.holderSnapshot.length > 0,
    at("holderSnapshot must be non-empty"),
  );
  const snapshotAddresses = new Set();
  const snapshotInputs = drop.holderSnapshot.map((holder, index) => {
    const prefix = at(`holderSnapshot[${index}]`);
    assert(holder && typeof holder === "object", `${prefix} must be an object`);
    address(holder.address, `${prefix}.address`);
    const key = holder.address.toLowerCase();
    assert(!snapshotAddresses.has(key), `${prefix}.address is duplicated`);
    snapshotAddresses.add(key);
    if (index > 0) {
      const previous = drop.holderSnapshot[index - 1].address.toLowerCase();
      assert(previous.localeCompare(key) < 0, at("holderSnapshot must be address-sorted"));
    }
    const minimumBalance = decimal(holder.minimumBalance, `${prefix}.minimumBalance`);
    assert(
      Number.isInteger(holder.streak) && holder.streak >= 0,
      `${prefix}.streak is invalid`,
    );
    assert(typeof holder.excluded === "boolean", `${prefix}.excluded must be boolean`);
    return {
      address: holder.address,
      minimumBalance,
      streak: holder.streak,
      excluded: holder.excluded,
    };
  });
  const expectedSnapshotHash = keccak256(
    encodeAbiParameters(snapshotParameters, [
      drop.dropId,
      snapshotInputs.map((holder) => holder.address),
      snapshotInputs.map((holder) => holder.minimumBalance),
      snapshotInputs.map((holder) => BigInt(holder.streak)),
      snapshotInputs.map((holder) => holder.excluded),
    ]),
  );
  sameHex(drop.holderSnapshotHash, expectedSnapshotHash, at("holderSnapshotHash"));

  assert(drop.window && typeof drop.window === "object", at("window must be an object"));
  assert(
    Number.isInteger(drop.window.sequence) && drop.window.sequence > 0,
    at("window.sequence must be positive"),
  );
  const startBlock = decimal(drop.window.startBlock, at("window.startBlock"));
  const endBlock = decimal(drop.window.endBlock, at("window.endBlock"));
  assert(endBlock >= startBlock, at("window end must not precede start"));
  assert(
    typeof drop.window.rulesVersion === "string" && drop.window.rulesVersion.length > 0,
    at("window.rulesVersion is required"),
  );

  const rewardAmount = decimal(drop.rewardAmount, at("rewardAmount"));
  assert(rewardAmount > 0n, at("rewardAmount must be positive"));
  const floorTokenAmount = decimal(drop.floorTokenAmount, at("floorTokenAmount"));
  assert(floorTokenAmount > 0n, at("floorTokenAmount must be positive"));
  const publishedTotalWeight = decimal(drop.totalWeight, at("totalWeight"));
  const recomputedAllocation = allocateHolderPool(
    rewardAmount,
    floorTokenAmount,
    snapshotInputs,
  );
  assert(
    recomputedAllocation.undistributed === 0n,
    at("snapshot does not fully allocate rewardAmount"),
  );
  assert(
    drop.eligibleCount === recomputedAllocation.eligibleCount,
    at("eligibleCount does not reproduce from holderSnapshot"),
  );
  assert(
    publishedTotalWeight === recomputedAllocation.totalWeight,
    at("totalWeight does not reproduce from holderSnapshot"),
  );

  assert(
    Array.isArray(drop.allocations) && drop.allocations.length > 0,
    at("allocations must be non-empty"),
  );
  assert(
    drop.allocations.length === recomputedAllocation.allocations.length,
    at("allocations length does not reproduce from holderSnapshot"),
  );
  const commitment = buildDistributionCommitment(
    drop.dropId,
    recomputedAllocation.allocations.map(({ address: recipient, amount }) => ({
      address: recipient,
      amount,
    })),
  );
  sameHex(drop.allocationRoot, commitment.allocationRoot, at("allocationRoot"));
  sameHex(drop.batchesRoot, commitment.batchesRoot, at("batchesRoot"));
  assert(commitment.totalAmount === rewardAmount, at("commitment total is inconsistent"));

  const holders = new Set();
  let allocationTotal = 0n;
  for (const [index, published] of drop.allocations.entries()) {
    const prefix = at(`allocations[${index}]`);
    const expected = recomputedAllocation.allocations[index];
    const proof = commitment.entries[index];
    assert(expected && proof, `${prefix} has no recomputed allocation`);
    address(published.address, `${prefix}.address`);
    assert(
      published.address === expected.address,
      `${prefix}.address does not reproduce from holderSnapshot`,
    );
    const key = published.address.toLowerCase();
    assert(!holders.has(key), `${prefix}.address is duplicated`);
    holders.add(key);
    assert(
      decimal(published.minimumBalance, `${prefix}.minimumBalance`) === expected.minimumBalance,
      `${prefix}.minimumBalance does not reproduce`,
    );
    assert(published.streak === expected.streak, `${prefix}.streak does not reproduce`);
    assert(
      decimal(published.multiplierBps, `${prefix}.multiplierBps`) === expected.multiplierBps,
      `${prefix}.multiplierBps does not reproduce`,
    );
    assert(
      decimal(published.weight, `${prefix}.weight`) === expected.weight,
      `${prefix}.weight does not reproduce`,
    );
    const amount = decimal(published.amount, `${prefix}.amount`);
    assert(amount === expected.amount, `${prefix}.amount does not reproduce`);
    allocationTotal += amount;
    sameHex(published.leaf, proof.leaf, `${prefix}.leaf`);
    sameHexArray(published.proof, proof.proof, `${prefix}.proof`);
  }
  assert(allocationTotal === rewardAmount, at("allocation sum must equal rewardAmount"));

  assert(
    Array.isArray(drop.batches) && drop.batches.length > 0,
    at("batches must be non-empty"),
  );
  assert(
    drop.expectedBatches === commitment.batches.length &&
      drop.batches.length === commitment.batches.length,
    at("expectedBatches and batches do not reproduce"),
  );
  let batchTotal = 0n;
  const batchRecipients = new Set();
  for (const [index, batch] of drop.batches.entries()) {
    const prefix = at(`batches[${index}]`);
    const expected = commitment.batches[index];
    assert(expected, `${prefix} has no recomputed batch`);
    assert(batch.index === index, `${prefix}.index must be sequential from zero`);
    assert(
      Array.isArray(batch.recipients) &&
        batch.recipients.length > 0 &&
        batch.recipients.length <= 200,
      `${prefix}.recipients length is invalid`,
    );
    assert(
      Array.isArray(batch.amounts) && batch.amounts.length === batch.recipients.length,
      `${prefix}.amounts must align with recipients`,
    );
    assert(
      batch.recipients.length === expected.recipients.length,
      `${prefix}.recipients length does not reproduce`,
    );
    for (const [recipientIndex, recipient] of batch.recipients.entries()) {
      address(recipient, `${prefix}.recipients[${recipientIndex}]`);
      assert(
        recipient === expected.recipients[recipientIndex],
        `${prefix}.recipients[${recipientIndex}] does not reproduce`,
      );
      const key = recipient.toLowerCase();
      assert(holders.has(key), `${prefix} contains a recipient absent from allocations`);
      assert(!batchRecipients.has(key), `${prefix} duplicates a recipient across batches`);
      batchRecipients.add(key);
      const amount = decimal(batch.amounts[recipientIndex], `${prefix}.amounts[${recipientIndex}]`);
      assert(
        amount === expected.amounts[recipientIndex],
        `${prefix}.amounts[${recipientIndex}] does not reproduce`,
      );
      batchTotal += amount;
    }
    sameHex(batch.batchHash, expected.batchHash, `${prefix}.batchHash`);
    sameHex(batch.leaf, expected.leaf, `${prefix}.leaf`);
    sameHexArray(batch.proof, expected.proof, `${prefix}.proof`);
    const operatorCalldata = encodeFunctionData({
      abi: distributorAbi,
      functionName: "distributeBatch",
      args: [
        drop.dropId,
        BigInt(index),
        expected.recipients,
        expected.amounts,
        expected.proof,
      ],
    });
    assert(
      typeof batch.operatorCalldata === "string" &&
        batch.operatorCalldata.toLowerCase() === operatorCalldata.toLowerCase(),
      `${prefix}.operatorCalldata does not reproduce`,
    );
    transaction(
      batch.operatorTransaction,
      `${prefix}.operatorTransaction`,
      asset.distributorAddress,
      operatorCalldata,
    );
  }
  assert(
    batchRecipients.size === holders.size,
    at("batches must cover every allocation exactly once"),
  );
  assert(batchTotal === rewardAmount, at("batch sum must equal rewardAmount"));

  const createDropCalldata = encodeFunctionData({
    abi: distributorAbi,
    functionName: "createDrop",
    args: [
      drop.dropId,
      commitment.allocationRoot,
      commitment.batchesRoot,
      commitment.totalAmount,
      commitment.batches.length,
    ],
  });
  const finalizeDropCalldata = encodeFunctionData({
    abi: distributorAbi,
    functionName: "finalizeDrop",
    args: [drop.dropId],
  });
  assert(
    typeof drop.safeCreateDropCalldata === "string" &&
      drop.safeCreateDropCalldata.toLowerCase() === createDropCalldata.toLowerCase(),
    at("safeCreateDropCalldata does not reproduce"),
  );
  assert(
    typeof drop.safeFinalizeDropCalldata === "string" &&
      drop.safeFinalizeDropCalldata.toLowerCase() === finalizeDropCalldata.toLowerCase(),
    at("safeFinalizeDropCalldata does not reproduce"),
  );
  transaction(
    drop.safeCreateDropTransaction,
    at("safeCreateDropTransaction"),
    asset.distributorAddress,
    createDropCalldata,
  );
  transaction(
    drop.safeFinalizeDropTransaction,
    at("safeFinalizeDropTransaction"),
    asset.distributorAddress,
    finalizeDropCalldata,
  );
}

async function validateReconciliation(record, file) {
  const at = (field) => `${file}: ${field}`;
  assert(
    record && typeof record === "object" && !Array.isArray(record),
    at("record must be an object"),
  );
  assert(record.schemaVersion === 1, at("schemaVersion must be 1"));
  assert(record.chainId === 4663, at("chainId must be Robinhood Chain 4663"));
  bytes32(record.dropId, at("dropId"));
  address(record.rewardAsset, at("rewardAsset"));
  address(record.distributorAddress, at("distributorAddress"));
  assert(
    typeof record.artifactPath === "string" && /^drops\/.+\.json$/.test(record.artifactPath),
    at("artifactPath is invalid"),
  );
  assert(
    typeof record.artifactSha256 === "string" && /^[0-9a-f]{64}$/.test(record.artifactSha256),
    at("artifactSha256 is invalid"),
  );
  bytes32(record.createDropTxHash, at("createDropTxHash"));
  assert(
    Array.isArray(record.batchTxHashes) && record.batchTxHashes.length > 0,
    at("batchTxHashes must be non-empty"),
  );
  record.batchTxHashes.forEach((hash, index) =>
    bytes32(hash, at(`batchTxHashes[${index}]`)),
  );
  bytes32(record.finalizeDropTxHash, at("finalizeDropTxHash"));
  const transactionHashes = [
    record.createDropTxHash,
    ...record.batchTxHashes,
    record.finalizeDropTxHash,
  ].map((hash) => hash.toLowerCase());
  assert(
    new Set(transactionHashes).size === transactionHashes.length,
    at("transaction hashes must be unique"),
  );
  const funded = decimal(record.fundedAmount, at("fundedAmount"));
  const distributed = decimal(record.distributedAmount, at("distributedAmount"));
  const dust = decimal(record.returnedDust, at("returnedDust"));
  assert(
    funded === distributed + dust,
    at("fundedAmount must equal distributedAmount plus returnedDust"),
  );
  assert(
    typeof record.completedAt === "string" && Number.isFinite(Date.parse(record.completedAt)),
    at("completedAt must be an ISO date-time"),
  );

  const dropsRoot = await realpath(resolve(root, "drops"));
  const artifactPath = await realpath(resolve(root, record.artifactPath));
  assert(
    artifactPath.startsWith(`${dropsRoot}${sep}`),
    at("artifactPath must resolve inside drops/"),
  );
  const artifactBytes = await readFile(artifactPath);
  const artifactDigest = createHash("sha256").update(artifactBytes).digest("hex");
  assert(artifactDigest === record.artifactSha256, at("artifactSha256 does not match the file"));
  const artifact = JSON.parse(artifactBytes.toString("utf8"));
  assert(artifact.dropId.toLowerCase() === record.dropId.toLowerCase(), at("dropId does not match artifact"));
  assert(
    artifact.rewardAsset.tokenAddress.toLowerCase() === record.rewardAsset.toLowerCase(),
    at("rewardAsset does not match artifact"),
  );
  assert(
    artifact.rewardAsset.distributorAddress.toLowerCase() ===
      record.distributorAddress.toLowerCase(),
    at("distributorAddress does not match artifact"),
  );
  assert(
    decimal(artifact.rewardAmount, at("artifact.rewardAmount")) === distributed,
    at("distributedAmount does not match artifact rewardAmount"),
  );
  assert(
    artifact.expectedBatches === record.batchTxHashes.length,
    at("batch transaction count does not match artifact"),
  );
}

let schemaCount = 0;
for (const path of await jsonFiles("schemas")) {
  const schema = JSON.parse(await readFile(path, "utf8"));
  assert(
    schema.$schema === "https://json-schema.org/draft/2020-12/schema",
    `${relative(root, path)}: unsupported JSON Schema draft`,
  );
  schemaCount += 1;
}

let dropCount = 0;
for (const path of await jsonFiles("drops")) {
  validateDrop(
    JSON.parse(await readFile(path, "utf8")),
    relative(root, path).replaceAll("\\", "/"),
  );
  dropCount += 1;
}

let reconciliationCount = 0;
for (const path of await jsonFiles("reconciliations")) {
  await validateReconciliation(
    JSON.parse(await readFile(path, "utf8")),
    relative(root, path).replaceAll("\\", "/"),
  );
  reconciliationCount += 1;
}

console.log(
  `Reproduced and validated ${schemaCount} schemas, ${dropCount} drops, and ${reconciliationCount} reconciliations.`,
);
