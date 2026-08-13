import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  allocateCommunityPool,
  allocateHolderPool,
  applyParticipationGate,
  buildDistributionCommitment,
  buildSurpriseCandidateSet,
  deriveDiamondWindow,
  deriveSurpriseSeed,
  mergeRewardAllocations,
  parseDeploymentManifestJson,
  scoreCommunityContributions,
  selectSurpriseDrop,
  splitHolderCommunityBudget,
} from "@cheap/protocol";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  stringToHex,
} from "viem";

const root = resolve(import.meta.dirname, "..");
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const decimalPattern = /^(0|[1-9][0-9]*)$/;
const hexDataPattern = /^0x(?:[0-9a-fA-F]{2})*$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const dropSchemaId = "https://cheapcoin.fun/schemas/diamond-drop-v3.schema.json";
const combinedDropSchemaId = "https://cheapcoin.fun/schemas/diamond-drop-v4.schema.json";
const participationDropSchemaId = "https://cheapcoin.fun/schemas/diamond-drop-v5.schema.json";
const strictDiamondDropSchemaId = "https://cheapcoin.fun/schemas/diamond-drop-v6.schema.json";
const surpriseDropSchemaId = "https://cheapcoin.fun/schemas/surprise-drop-v7.schema.json";
const reconciliationSchemaId = "https://cheapcoin.fun/schemas/reconciliation-v1.schema.json";
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
let dropSchemaValidator;
let combinedDropSchemaValidator;
let participationDropSchemaValidator;
let strictDiamondDropSchemaValidator;
let surpriseDropSchemaValidator;
let reconciliationSchemaValidator;
let deploymentSchemaValidator;
let publishedRules = new Map();
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
const gateParameters = parseAbiParameters(
  "bytes32 dropId, bytes32 scoreOutput, uint256 minimumPoints, uint256 minimumEvents, address[] holders, uint256[] points, uint256[] events, bool[] qualified",
);
const rewardableActions = new Set([
  "x_original_post",
  "x_educational_thread",
  "x_space_host",
  "x_space_speaker",
  "tiktok_original_video",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateAgainstSchema(validator, value, file) {
  assert(validator, `${file}: matching JSON Schema is not loaded`);
  if (!validator(value)) {
    throw new Error(`${file}: ${ajv.errorsText(validator.errors, { separator: "; " })}`);
  }
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

async function jsonFiles(directory, allowedFiles = new Set(["README.md"])) {
  const base = resolve(root, directory);
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      assert(!entry.isSymbolicLink(), `${relative(root, path)}: symbolic links are not allowed`);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(path);
      } else if (!entry.isFile() || !allowedFiles.has(entry.name)) {
        throw new Error(`${relative(root, path)}: unexpected evidence file`);
      }
    }
  }
  await walk(base);
  return files.sort();
}

async function validateProtocolDeployments() {
  const deploymentsDirectory = resolve(root, "vendor", "cheap-protocol", "deployments");
  const schemaPath = resolve(deploymentsDirectory, "deployment-manifest-v1.schema.json");
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  assert(
    schema.$schema === "https://json-schema.org/draft/2020-12/schema",
    "vendor/cheap-protocol/deployments/deployment-manifest-v1.schema.json: unsupported JSON Schema draft",
  );
  assert(
    typeof schema.$id === "string" && schema.$id.length > 0,
    "vendor/cheap-protocol/deployments/deployment-manifest-v1.schema.json: missing schema ID",
  );
  ajv.addSchema(schema);
  deploymentSchemaValidator = ajv.getSchema(schema.$id);
  assert(deploymentSchemaValidator, `Missing schema ${schema.$id}`);

  const entries = await readdir(deploymentsDirectory, { withFileTypes: true });
  const manifestEntries = [];
  for (const entry of entries) {
    const path = resolve(deploymentsDirectory, entry.name);
    const file = relative(root, path).replaceAll("\\", "/");
    assert(!entry.isSymbolicLink(), `${file}: symbolic links are not allowed`);
    assert(entry.isFile(), `${file}: nested deployment directories are not allowed`);
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*\.manifest\.json$/.test(entry.name)) {
      manifestEntries.push({ name: entry.name, path, file });
      continue;
    }
    assert(
      entry.name === "README.md" || entry.name === "deployment-manifest-v1.schema.json",
      `${file}: unexpected deployment file`,
    );
  }

  const manifestsById = new Map();
  const activeDeploymentIds = [];
  for (const entry of manifestEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    const bytes = await readFile(entry.path);
    const source = bytes.toString("utf8");
    let raw;
    try {
      raw = JSON.parse(source);
    } catch (error) {
      throw new Error(
        `${entry.file}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    validateAgainstSchema(deploymentSchemaValidator, raw, entry.file);

    let parsed;
    try {
      parsed = parseDeploymentManifestJson(source);
    } catch (error) {
      throw new Error(
        `${entry.file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const independentDigest = `0x${createHash("sha256").update(bytes).digest("hex")}`;
    assert(
      parsed.sha256 === independentDigest,
      `${entry.file}: protocol and independent SHA-256 digests disagree`,
    );
    assert(
      parsed.manifest.publication.manifestPath === `deployments/${entry.name}`,
      `${entry.file}: publication.manifestPath does not match its pinned protocol path`,
    );
    assert(
      !manifestsById.has(parsed.manifest.deploymentId),
      `${entry.file}: duplicate deploymentId ${parsed.manifest.deploymentId}`,
    );
    manifestsById.set(parsed.manifest.deploymentId, { file: entry.file, manifest: parsed.manifest });
    if (parsed.manifest.status.state === "active") {
      activeDeploymentIds.push(parsed.manifest.deploymentId);
    }
  }

  assert(
    activeDeploymentIds.length <= 1,
    `Pinned protocol contains multiple active deployments: ${activeDeploymentIds.join(", ")}`,
  );
  if (manifestsById.size > 0) {
    assert(
      activeDeploymentIds.length === 1,
      "Pinned protocol deployment history must contain exactly one active deployment",
    );
  }

  for (const [deploymentId, record] of manifestsById) {
    const visited = new Set([deploymentId]);
    let current = record;
    while (current.manifest.status.state === "superseded") {
      const replacementId = current.manifest.status.supersededBy;
      assert(
        !visited.has(replacementId),
        `${record.file}: supersession chain contains a cycle through ${replacementId}`,
      );
      visited.add(replacementId);
      const replacement = manifestsById.get(replacementId);
      assert(
        replacement,
        `${record.file}: supersededBy references missing deployment ${replacementId}`,
      );
      current = replacement;
    }
    assert(
      current.manifest.deploymentId === activeDeploymentIds[0],
      `${record.file}: supersession chain does not terminate at the active deployment`,
    );
  }

  return manifestsById.size;
}

async function loadPublishedRules() {
  const rulesDirectory = resolve(root, "rules");
  const entries = await readdir(rulesDirectory, { withFileTypes: true });
  const ruleFiles = [];
  for (const entry of entries) {
    const path = resolve(rulesDirectory, entry.name);
    assert(!entry.isSymbolicLink(), `rules/${entry.name}: symbolic links are not allowed`);
    assert(entry.isFile(), `rules/${entry.name}: nested directories are not allowed`);
    if (/^(?:RULES|COMMUNITY-RULES)-v[0-9A-Za-z._-]+\.md$/.test(entry.name)) {
      ruleFiles.push(entry.name);
    } else {
      assert(
        entry.name === "README.md" || entry.name === "HASHES.md",
        `rules/${entry.name}: unexpected rules file`,
      );
    }
  }
  assert(ruleFiles.length > 0, "rules/: at least one versioned rules file is required");

  const table = await readFile(resolve(rulesDirectory, "HASHES.md"), "utf8");
  const recorded = new Map();
  for (const match of table.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)) {
    const [, name, digest] = match;
    assert(!recorded.has(name), `rules/HASHES.md: duplicate entry for ${name}`);
    recorded.set(name, digest);
  }
  assert(recorded.size === ruleFiles.length, "rules/HASHES.md must list every rules file once");

  const result = new Map();
  for (const name of ruleFiles.sort()) {
    const contents = await readFile(resolve(rulesDirectory, name));
    const digest = createHash("sha256").update(contents).digest("hex");
    assert(recorded.get(name) === digest, `rules/${name}: SHA-256 does not match HASHES.md`);
    result.set(`rules/${name}`, digest);
  }
  for (const name of recorded.keys()) {
    assert(ruleFiles.includes(name), `rules/HASHES.md: ${name} does not exist`);
  }
  return result;
}

function validateDrop(drop, file) {
  const at = (field) => `${file}: ${field}`;
  validateAgainstSchema(dropSchemaValidator, drop, file);
  assert(
    drop && typeof drop === "object" && !Array.isArray(drop),
    at("artifact must be an object"),
  );
  assert(drop.schemaVersion === 3, at("schemaVersion must be 3"));
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
  assert(
    typeof drop.window.rulesPath === "string" && publishedRules.has(drop.window.rulesPath),
    at("window.rulesPath is not a published rules file"),
  );
  assert(
    typeof drop.window.rulesSha256 === "string" && sha256Pattern.test(drop.window.rulesSha256),
    at("window.rulesSha256 must be a lowercase SHA-256 digest"),
  );
  assert(
    publishedRules.get(drop.window.rulesPath) === drop.window.rulesSha256,
    at("window.rulesSha256 does not match the published rules bytes"),
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

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function sameJson(actual, expected, field) {
  assert(
    JSON.stringify(canonicalJson(actual)) === JSON.stringify(canonicalJson(expected)),
    `${field} does not reproduce`,
  );
}

function jsonCommitment(value) {
  return keccak256(stringToHex(JSON.stringify(value)));
}

function reproduceCommunityScore(score, at) {
  assert(score.round.endTime >= score.round.startTime, at("participation round timestamps are invalid"));
  assert(
    publishedRules.get(score.round.rulesPath) === score.round.rulesSha256,
    at("participation rules hash does not match published bytes"),
  );
  const scoringRules = score.rules.map((rule, index) => {
    if (index > 0) {
      assert(
        score.rules[index - 1].action.localeCompare(rule.action) < 0,
        at("participation rules must be action-sorted"),
      );
    }
    assert(rewardableActions.has(rule.action), at(`action ${rule.action} is not rewardable`));
    assert(rule.perUtcDay <= rule.perRound, at(`rule ${rule.action} has invalid caps`));
    return {
      action: rule.action,
      points: decimal(rule.points, at(`rule ${rule.action}.points`)),
      perUtcDay: rule.perUtcDay,
      perRound: rule.perRound,
    };
  });
  const approvedEvents = score.approvedEvents.map((event, index) => {
    bytes32(event.eventCommitment, at(`approvedEvents[${index}].eventCommitment`));
    assert(
      event.eventCommitment === event.eventCommitment.toLowerCase(),
      at(`approvedEvents[${index}].eventCommitment must be lowercase`),
    );
    address(event.address, at(`approvedEvents[${index}].address`));
    if (index > 0) {
      const previous = score.approvedEvents[index - 1];
      assert(
        previous.occurredAt < event.occurredAt ||
          (previous.occurredAt === event.occurredAt &&
            previous.eventCommitment.localeCompare(event.eventCommitment) < 0),
        at("approvedEvents must be time-and-commitment sorted"),
      );
    }
    return event;
  });
  const excluded = new Set();
  score.excludedAddresses.forEach((candidate, index) => {
    address(candidate, at(`excludedAddresses[${index}]`));
    const key = candidate.toLowerCase();
    assert(!excluded.has(key), at(`excludedAddresses[${index}] is duplicated`));
    if (index > 0) {
      assert(
        score.excludedAddresses[index - 1].toLowerCase().localeCompare(key) < 0,
        at("excludedAddresses must be address-sorted"),
      );
    }
    excluded.add(key);
  });
  const recomputed = scoreCommunityContributions({
    startTime: score.round.startTime,
    endTime: score.round.endTime,
    rules: scoringRules,
    events: approvedEvents,
    excludedAddresses: excluded,
  });
  assert(recomputed.totalPoints > 0n, at("score has no accepted points"));
  const committedInput = {
    round: {
      id: score.round.id,
      sequence: score.round.sequence,
      startTime: score.round.startTime,
      endTime: score.round.endTime,
      rulesVersion: score.round.rulesVersion,
      rulesPath: score.round.rulesPath,
      rulesSha256: score.round.rulesSha256,
    },
    rules: scoringRules.map((rule) => ({ ...rule, points: rule.points.toString() })),
    approvedEvents,
    excludedAddresses: score.excludedAddresses,
  };
  const inputCommitment = jsonCommitment(committedInput);
  sameHex(score.inputCommitment, inputCommitment, at("score.inputCommitment"));
  const result = {
    contributors: recomputed.contributors.map((contributor) => ({
      address: contributor.address,
      points: contributor.points.toString(),
      acceptedEvents: contributor.acceptedEvents,
    })),
    acceptedEvents: recomputed.acceptedEvents.map((event) => ({
      eventCommitment: event.eventCommitment,
      address: event.address,
      action: event.action,
      occurredAt: event.occurredAt,
      points: event.points.toString(),
    })),
    rejectedEvents: recomputed.rejectedEvents.map((event) => ({
      eventCommitment: event.eventCommitment,
      address: event.address,
      action: event.action,
      occurredAt: event.occurredAt,
      reason: event.reason,
    })),
    totalPoints: recomputed.totalPoints.toString(),
  };
  sameJson(score.contributors, result.contributors, at("score.contributors"));
  sameJson(score.acceptedEvents, result.acceptedEvents, at("score.acceptedEvents"));
  sameJson(score.rejectedEvents, result.rejectedEvents, at("score.rejectedEvents"));
  assert(score.totalPoints === result.totalPoints, at("score.totalPoints does not reproduce"));
  const outputCommitment = jsonCommitment({ inputCommitment, result });
  sameHex(score.outputCommitment, outputCommitment, at("score.outputCommitment"));
  return { recomputed, inputCommitment, outputCommitment };
}

function validateParticipationDrop(drop, file) {
  const at = (field) => `${file}: ${field}`;
  validateAgainstSchema(participationDropSchemaValidator, drop, file);
  assert(drop.schemaVersion === 5, at("schemaVersion must be 5"));
  assert(drop.chainId === 4663, at("chainId must be Robinhood Chain 4663"));
  bytes32(drop.dropId, at("dropId"));
  bytes32(drop.assetContextHash, at("assetContextHash"));
  bytes32(drop.allocationRoot, at("allocationRoot"));
  bytes32(drop.batchesRoot, at("batchesRoot"));

  const asset = drop.rewardAsset;
  address(asset.tokenAddress, at("rewardAsset.tokenAddress"));
  address(asset.distributorAddress, at("rewardAsset.distributorAddress"));
  sameHex(
    drop.assetContextHash,
    keccak256(encodeAbiParameters(assetContextParameters, [
      4663n,
      asset.tokenAddress,
      asset.distributorAddress,
      drop.dropId,
    ])),
    at("assetContextHash"),
  );

  const rewardAmount = decimal(drop.rewardAmount, at("rewardAmount"));
  assert(rewardAmount > 0n, at("rewardAmount must be positive"));
  assert(decimal(drop.window.endBlock, at("window.endBlock")) >=
    decimal(drop.window.startBlock, at("window.startBlock")), at("holder window is invalid"));
  assert(
    publishedRules.get(drop.window.rulesPath) === drop.window.rulesSha256,
    at("window rules hash does not match published bytes"),
  );

  const snapshotInputs = drop.holderPool.snapshot.map((holder, index) => {
    const prefix = at(`holderPool.snapshot[${index}]`);
    address(holder.address, `${prefix}.address`);
    if (index > 0) {
      assert(
        drop.holderPool.snapshot[index - 1].address.toLowerCase()
          .localeCompare(holder.address.toLowerCase()) < 0,
        at("holder snapshot must be address-sorted"),
      );
    }
    return {
      address: holder.address,
      minimumBalance: decimal(holder.minimumBalance, `${prefix}.minimumBalance`),
      streak: holder.streak,
      excluded: holder.excluded,
    };
  });
  sameHex(
    drop.holderPool.snapshotHash,
    keccak256(encodeAbiParameters(snapshotParameters, [
      drop.dropId,
      snapshotInputs.map((holder) => holder.address),
      snapshotInputs.map((holder) => holder.minimumBalance),
      snapshotInputs.map((holder) => BigInt(holder.streak)),
      snapshotInputs.map((holder) => holder.excluded),
    ])),
    at("holderPool.snapshotHash"),
  );

  const { recomputed: score } = reproduceCommunityScore(
    drop.participationGate.score,
    (field) => at(`participationGate.${field}`),
  );
  const minimumPoints = decimal(
    drop.participationGate.minimumPoints,
    at("participationGate.minimumPoints"),
  );
  assert(minimumPoints > 0n, at("participation minimum must be positive"));
  const minimumAcceptedEvents = drop.participationGate.minimumAcceptedEvents;
  assert(
    Number.isSafeInteger(minimumAcceptedEvents) && minimumAcceptedEvents > 0,
    at("participation event minimum must be positive"),
  );
  const gated = applyParticipationGate(
    snapshotInputs,
    score.contributors,
    { minimumPoints, minimumAcceptedEvents },
  );
  assert(
    gated.participationQualifiedCount === drop.participationGate.participationQualifiedCount,
    at("participationQualifiedCount does not reproduce"),
  );
  const decisions = gated.decisions.map((decision) => ({
    address: decision.address,
    points: decision.points.toString(),
    acceptedEvents: decision.acceptedEvents,
    holderExcluded: decision.holderExcluded,
    pointsQualified: decision.pointsQualified,
    eventsQualified: decision.eventsQualified,
    participationQualified: decision.participationQualified,
  }));
  sameJson(drop.participationGate.decisions, decisions, at("participationGate.decisions"));
  sameHex(
    drop.participationGate.gateHash,
    keccak256(encodeAbiParameters(gateParameters, [
      drop.dropId,
      drop.participationGate.score.outputCommitment,
      minimumPoints,
      BigInt(minimumAcceptedEvents),
      decisions.map((decision) => decision.address),
      decisions.map((decision) => BigInt(decision.points)),
      decisions.map((decision) => BigInt(decision.acceptedEvents)),
      decisions.map((decision) => decision.participationQualified),
    ])),
    at("participationGate.gateHash"),
  );

  const allocation = allocateHolderPool(
    rewardAmount,
    decimal(drop.holderPool.floorTokenAmount, at("holderPool.floorTokenAmount")),
    gated.holders,
  );
  assert(allocation.undistributed === 0n, at("funded reward is not fully allocated"));
  assert(allocation.eligibleCount === drop.holderPool.eligibleCount, at("eligibleCount does not reproduce"));
  assert(allocation.totalWeight === decimal(drop.holderPool.totalWeight, at("holderPool.totalWeight")), at("totalWeight does not reproduce"));
  const commitment = buildDistributionCommitment(
    drop.dropId,
    allocation.allocations.map(({ address: recipient, amount }) => ({ address: recipient, amount })),
  );
  sameHex(drop.allocationRoot, commitment.allocationRoot, at("allocationRoot"));
  sameHex(drop.batchesRoot, commitment.batchesRoot, at("batchesRoot"));
  assert(drop.recipientCount === allocation.allocations.length, at("recipientCount does not reproduce"));
  const decisionByAddress = new Map(gated.decisions.map((decision) => [decision.address.toLowerCase(), decision]));
  sameJson(
    drop.allocations,
    allocation.allocations.map((holder, index) => {
      const decision = decisionByAddress.get(holder.address.toLowerCase());
      assert(decision, at(`allocation ${holder.address} has no gate decision`));
      return {
        address: holder.address,
        minimumBalance: holder.minimumBalance.toString(),
        streak: holder.streak,
        multiplierBps: holder.multiplierBps.toString(),
        weight: holder.weight.toString(),
        participationPoints: decision.points.toString(),
        acceptedEvents: decision.acceptedEvents,
        amount: holder.amount.toString(),
        leaf: commitment.entries[index].leaf,
        proof: commitment.entries[index].proof,
      };
    }),
    at("allocations"),
  );

  assert(
    drop.expectedBatches === commitment.batches.length &&
      drop.batches.length === commitment.batches.length,
    at("expectedBatches does not reproduce"),
  );
  for (const [index, expected] of commitment.batches.entries()) {
    const operatorCalldata = encodeFunctionData({
      abi: distributorAbi,
      functionName: "distributeBatch",
      args: [drop.dropId, BigInt(index), expected.recipients, expected.amounts, expected.proof],
    });
    sameJson(drop.batches[index], {
      index,
      recipients: expected.recipients,
      amounts: expected.amounts.map(String),
      batchHash: expected.batchHash,
      leaf: expected.leaf,
      proof: expected.proof,
      operatorCalldata,
      operatorTransaction: { to: asset.distributorAddress, value: "0", data: operatorCalldata },
    }, at(`batches[${index}]`));
  }
  const createDropCalldata = encodeFunctionData({
    abi: distributorAbi,
    functionName: "createDrop",
    args: [drop.dropId, commitment.allocationRoot, commitment.batchesRoot, rewardAmount, commitment.batches.length],
  });
  const finalizeDropCalldata = encodeFunctionData({
    abi: distributorAbi,
    functionName: "finalizeDrop",
    args: [drop.dropId],
  });
  assert(drop.safeCreateDropCalldata.toLowerCase() === createDropCalldata.toLowerCase(), at("safeCreateDropCalldata does not reproduce"));
  assert(drop.safeFinalizeDropCalldata.toLowerCase() === finalizeDropCalldata.toLowerCase(), at("safeFinalizeDropCalldata does not reproduce"));
  transaction(drop.safeCreateDropTransaction, at("safeCreateDropTransaction"), asset.distributorAddress, createDropCalldata);
  transaction(drop.safeFinalizeDropTransaction, at("safeFinalizeDropTransaction"), asset.distributorAddress, finalizeDropCalldata);
}

function validateStrictDiamondDrop(drop, file) {
  const at = (field) => `${file}: ${field}`;
  validateAgainstSchema(strictDiamondDropSchemaValidator, drop, file);
  assert(drop.schemaVersion === 6 && drop.program === "cost_diamond_drop", at("program is invalid"));
  assert(drop.chainId === 4663, at("chainId must be Robinhood Chain 4663"));
  assert(publishedRules.get(drop.window.rulesPath) === drop.window.rulesSha256, at("rules hash does not match published bytes"));
  const expectedAssetContextHash = keccak256(encodeAbiParameters(assetContextParameters, [
    4663n,
    drop.rewardAsset.tokenAddress,
    drop.rewardAsset.distributorAddress,
    drop.dropId,
  ]));
  sameHex(drop.assetContextHash, expectedAssetContextHash, at("assetContextHash"));

  const selected = deriveDiamondWindow({
    selectionId: drop.window.selection.selectionId,
    startBlock: decimal(drop.window.startBlock, at("window.startBlock")),
    minimumDurationBlocks: decimal(drop.window.selection.minimumDurationBlocks, at("window.selection.minimumDurationBlocks")),
    maximumDurationBlocks: decimal(drop.window.selection.maximumDurationBlocks, at("window.selection.maximumDurationBlocks")),
    entropyBlockNumber: decimal(drop.window.selection.entropyBlockNumber, at("window.selection.entropyBlockNumber")),
    entropyBlockHash: drop.window.selection.entropyBlockHash,
  });
  const expectedSelection = {
    selectionId: selected.selectionId,
    minimumDurationBlocks: selected.minimumDurationBlocks.toString(),
    maximumDurationBlocks: selected.maximumDurationBlocks.toString(),
    minimumEndBlock: selected.minimumEndBlock.toString(),
    maximumEndBlock: selected.maximumEndBlock.toString(),
    selectedDurationBlocks: selected.selectedDurationBlocks.toString(),
    entropyBlockNumber: selected.entropyBlockNumber.toString(),
    entropyBlockHash: selected.entropyBlockHash,
    randomWord: selected.randomWord,
    rejectionCount: selected.rejectionCount,
  };
  sameJson(drop.window.selection, expectedSelection, at("window.selection"));
  assert(drop.window.endBlock === selected.endBlock.toString(), at("window.endBlock does not reproduce"));

  const holders = drop.holderSnapshot.map((holder) => ({
    address: holder.address,
    minimumBalance: decimal(holder.minimumBalance, at("holder minimumBalance")),
    streak: holder.streak,
    outboundTransfer: holder.outboundTransfer,
    excluded: holder.excluded,
  }));
  const snapshotHash = keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32 dropId, address[] holders, uint256[] minimumBalances, uint256[] streaks, bool[] outboundTransfers, bool[] exclusions"),
    [drop.dropId, holders.map(({ address: holder }) => holder), holders.map(({ minimumBalance }) => minimumBalance),
      holders.map(({ streak }) => BigInt(streak)), holders.map(({ outboundTransfer }) => outboundTransfer),
      holders.map(({ excluded }) => excluded)],
  ));
  sameHex(drop.holderSnapshotHash, snapshotHash, at("holderSnapshotHash"));
  const allocation = allocateHolderPool(
    decimal(drop.rewardAmount, at("rewardAmount")),
    decimal(drop.floorTokenAmount, at("floorTokenAmount")),
    holders,
  );
  assert(allocation.undistributed === 0n, at("budget is not fully allocated"));
  assert(allocation.eligibleCount === drop.eligibleCount, at("eligibleCount does not reproduce"));
  assert(allocation.totalWeight === decimal(drop.totalWeight, at("totalWeight")), at("totalWeight does not reproduce"));
  const commitment = buildDistributionCommitment(
    drop.dropId,
    allocation.allocations.map(({ address: recipient, amount }) => ({ address: recipient, amount })),
  );
  sameHex(drop.allocationRoot, commitment.allocationRoot, at("allocationRoot"));
  sameHex(drop.batchesRoot, commitment.batchesRoot, at("batchesRoot"));
  sameJson(drop.allocations, allocation.allocations.map((holder, index) => ({
    address: holder.address,
    minimumBalance: holder.minimumBalance.toString(),
    streak: holder.streak,
    outboundTransfer: Boolean(holder.outboundTransfer),
    multiplierBps: holder.multiplierBps.toString(),
    weight: holder.weight.toString(),
    amount: holder.amount.toString(),
    leaf: commitment.entries[index].leaf,
    proof: commitment.entries[index].proof,
  })), at("allocations"));
  validateCommittedTransactions(drop, commitment, at);
}

function validateSurpriseDrop(drop, file) {
  const at = (field) => `${file}: ${field}`;
  validateAgainstSchema(surpriseDropSchemaValidator, drop, file);
  assert(drop.schemaVersion === 7 && drop.program === "cheap_surprise_drop", at("program is invalid"));
  assert(drop.chainId === 4663, at("chainId must be Robinhood Chain 4663"));
  assert(drop.rewardAsset.symbol === "CHEAP", at("reward asset must be CHEAP"));
  assert(publishedRules.get(drop.round.holdingRulesPath) === drop.round.holdingRulesSha256, at("holding rules hash does not match"));
  assert(publishedRules.get(drop.round.rulesPath) === drop.round.rulesSha256, at("community rules hash does not match"));
  assert(BigInt(drop.entropy.blockNumber) > BigInt(drop.round.endBlock), at("entropy must follow candidate freeze"));

  const score = drop.score;
  assert(score.round.id === drop.round.id && score.round.sequence === drop.round.sequence, at("score round identity does not match candidate round"));
  assert(score.round.rulesVersion === drop.round.rulesVersion, at("score rules version does not match candidate round"));
  assert(score.round.rulesPath === drop.round.rulesPath, at("score rules path does not match candidate round"));
  assert(score.round.rulesSha256 === drop.round.rulesSha256, at("score rules hash does not match candidate round"));
  const scoringRules = score.rules.map((rule, index) => {
    if (index > 0) {
      assert(score.rules[index - 1].action.localeCompare(rule.action) < 0, at("score rules must be action-sorted"));
    }
    assert(rewardableActions.has(rule.action), at(`score rule ${rule.action} is not rewardable`));
    assert(rule.perUtcDay <= rule.perRound, at(`score rule ${rule.action} has invalid caps`));
    return {
      action: rule.action,
      points: decimal(rule.points, at(`score rule ${rule.action}.points`)),
      perUtcDay: rule.perUtcDay,
      perRound: rule.perRound,
    };
  });
  const approvedEvents = score.approvedEvents.map((event, index) => {
    bytes32(event.eventCommitment, at(`score.approvedEvents[${index}].eventCommitment`));
    address(event.address, at(`score.approvedEvents[${index}].address`));
    if (index > 0) {
      const previous = score.approvedEvents[index - 1];
      assert(
        previous.occurredAt < event.occurredAt ||
          (previous.occurredAt === event.occurredAt && previous.eventCommitment.localeCompare(event.eventCommitment) < 0),
        at("score approved events must be time-and-commitment sorted"),
      );
    }
    return event;
  });
  const excludedAddresses = new Set();
  score.excludedAddresses.forEach((candidate, index) => {
    address(candidate, at(`score.excludedAddresses[${index}]`));
    const key = candidate.toLowerCase();
    assert(!excludedAddresses.has(key), at(`score.excludedAddresses[${index}] is duplicated`));
    if (index > 0) {
      assert(score.excludedAddresses[index - 1].toLowerCase().localeCompare(key) < 0, at("score exclusions must be address-sorted"));
    }
    excludedAddresses.add(key);
  });
  const recomputedScore = scoreCommunityContributions({
    startTime: score.round.startTime,
    endTime: score.round.endTime,
    rules: scoringRules,
    events: approvedEvents,
    excludedAddresses,
  });
  const committedInput = {
    round: score.round,
    rules: scoringRules.map((rule) => ({ ...rule, points: rule.points.toString() })),
    approvedEvents,
    excludedAddresses: score.excludedAddresses,
  };
  const inputCommitment = jsonCommitment(committedInput);
  sameHex(score.inputCommitment, inputCommitment, at("score.inputCommitment"));
  const scoringResult = {
    contributors: recomputedScore.contributors.map((contributor) => ({
      address: contributor.address,
      points: contributor.points.toString(),
      acceptedEvents: contributor.acceptedEvents,
    })),
    acceptedEvents: recomputedScore.acceptedEvents.map((event) => ({
      eventCommitment: event.eventCommitment,
      address: event.address,
      action: event.action,
      occurredAt: event.occurredAt,
      points: event.points.toString(),
    })),
    rejectedEvents: recomputedScore.rejectedEvents.map((event) => ({
      eventCommitment: event.eventCommitment,
      address: event.address,
      action: event.action,
      occurredAt: event.occurredAt,
      reason: event.reason,
    })),
    totalPoints: recomputedScore.totalPoints.toString(),
  };
  sameJson(score.contributors, scoringResult.contributors, at("score.contributors"));
  sameJson(score.acceptedEvents, scoringResult.acceptedEvents, at("score.acceptedEvents"));
  sameJson(score.rejectedEvents, scoringResult.rejectedEvents, at("score.rejectedEvents"));
  assert(score.totalPoints === scoringResult.totalPoints, at("score.totalPoints does not reproduce"));
  sameHex(score.outputCommitment, jsonCommitment({ inputCommitment, result: scoringResult }), at("score.outputCommitment"));

  const config = {
    roundId: drop.dropId,
    rewardAmount: decimal(drop.rewardAmount, at("rewardAmount")),
    winnerCount: drop.winnerCount,
    minimumPoints: decimal(drop.selectionRules.minimumPoints, at("minimumPoints")),
    minimumAcceptedEvents: drop.selectionRules.minimumAcceptedEvents,
    floorTokenAmount: decimal(drop.selectionRules.floorTokenAmount, at("floorTokenAmount")),
    holdingUnit: decimal(drop.selectionRules.holdingUnit, at("holdingUnit")),
    maximumHoldingUnits: decimal(drop.selectionRules.maximumHoldingUnits, at("maximumHoldingUnits")),
    maximumActivityPoints: decimal(drop.selectionRules.maximumActivityPoints, at("maximumActivityPoints")),
  };
  const candidates = drop.candidates.map((candidate) => ({
    address: candidate.address,
    points: decimal(candidate.points, at("candidate.points")),
    acceptedEvents: candidate.acceptedEvents,
    minimumBalance: decimal(candidate.minimumBalance, at("candidate.minimumBalance")),
    excluded: candidate.excluded,
  }));
  assert(candidates.length === recomputedScore.contributors.length, at("candidate set must include every scored contributor"));
  const contributorByAddress = new Map(recomputedScore.contributors.map((contributor) => [contributor.address.toLowerCase(), contributor]));
  candidates.forEach((candidate) => {
    const contributor = contributorByAddress.get(candidate.address.toLowerCase());
    assert(contributor, at(`candidate ${candidate.address} is absent from the committed score`));
    assert(candidate.points === contributor.points, at(`candidate ${candidate.address} points do not match score`));
    assert(candidate.acceptedEvents === contributor.acceptedEvents, at(`candidate ${candidate.address} events do not match score`));
  });
  const frozen = buildSurpriseCandidateSet(config, candidates);
  sameJson(drop.candidates, frozen.decisions.map((candidate) => ({
    address: candidate.address,
    points: candidate.points.toString(),
    acceptedEvents: candidate.acceptedEvents,
    minimumBalance: candidate.minimumBalance.toString(),
    excluded: candidate.excluded,
    activityQualified: candidate.activityQualified,
    holdingQualified: candidate.holdingQualified,
    activityWeight: candidate.activityWeight.toString(),
    holdingUnits: candidate.holdingUnits.toString(),
    selectionWeight: candidate.selectionWeight.toString(),
    eligible: candidate.eligible,
  })), at("candidates"));
  sameHex(drop.candidateCommitment, frozen.candidateCommitment, at("candidateCommitment"));
  assert(drop.eligibleCandidateCount === frozen.eligibleCount, at("eligibleCandidateCount does not reproduce"));
  assert(decimal(drop.totalSelectionWeight, at("totalSelectionWeight")) === frozen.totalSelectionWeight, at("totalSelectionWeight does not reproduce"));
  const seed = deriveSurpriseSeed({
    candidateCommitment: frozen.candidateCommitment,
    entropyChainId: decimal(drop.entropy.chainId, at("entropy.chainId")),
    entropyBlockNumber: decimal(drop.entropy.blockNumber, at("entropy.blockNumber")),
    entropyBlockHash: drop.entropy.blockHash,
  });
  sameHex(drop.entropy.seed, seed, at("entropy.seed"));
  const selected = selectSurpriseDrop({ config, candidates, seed });
  const commitment = buildDistributionCommitment(
    drop.dropId,
    selected.winners.map(({ address: recipient, amount }) => ({ address: recipient, amount })),
  );
  sameHex(drop.allocationRoot, commitment.allocationRoot, at("allocationRoot"));
  sameHex(drop.batchesRoot, commitment.batchesRoot, at("batchesRoot"));
  sameJson(drop.allocations, selected.winners.map((winner) => {
    const entry = commitment.entries.find(({ address: recipient }) => recipient.toLowerCase() === winner.address.toLowerCase());
    assert(entry, at(`missing winner proof for ${winner.address}`));
    return {
      address: winner.address, draw: winner.draw, points: winner.points.toString(),
      acceptedEvents: winner.acceptedEvents, minimumBalance: winner.minimumBalance.toString(),
      activityWeight: winner.activityWeight.toString(), holdingUnits: winner.holdingUnits.toString(),
      selectionWeight: winner.selectionWeight.toString(), ticket: winner.ticket.toString(),
      totalWeightAtDraw: winner.totalWeightAtDraw.toString(), randomWord: winner.randomWord,
      rejectionCount: winner.rejectionCount, amount: winner.amount.toString(), leaf: entry.leaf, proof: entry.proof,
    };
  }), at("allocations"));
  validateCommittedTransactions(drop, commitment, at);
}

function validateCommittedTransactions(drop, commitment, at) {
  const asset = drop.rewardAsset;
  assert(drop.expectedBatches === commitment.batches.length && drop.batches.length === commitment.batches.length, at("expectedBatches does not reproduce"));
  for (const [index, expected] of commitment.batches.entries()) {
    const calldata = encodeFunctionData({ abi: distributorAbi, functionName: "distributeBatch",
      args: [drop.dropId, BigInt(index), expected.recipients, expected.amounts, expected.proof] });
    sameJson(drop.batches[index], { index, recipients: expected.recipients, amounts: expected.amounts.map(String),
      batchHash: expected.batchHash, leaf: expected.leaf, proof: expected.proof, operatorCalldata: calldata,
      operatorTransaction: { to: asset.distributorAddress, value: "0", data: calldata } }, at(`batches[${index}]`));
  }
  const createCalldata = encodeFunctionData({ abi: distributorAbi, functionName: "createDrop",
    args: [drop.dropId, commitment.allocationRoot, commitment.batchesRoot, commitment.totalAmount, commitment.batches.length] });
  const finalizeCalldata = encodeFunctionData({ abi: distributorAbi, functionName: "finalizeDrop", args: [drop.dropId] });
  assert(drop.safeCreateDropCalldata.toLowerCase() === createCalldata.toLowerCase(), at("safeCreateDropCalldata does not reproduce"));
  assert(drop.safeFinalizeDropCalldata.toLowerCase() === finalizeCalldata.toLowerCase(), at("safeFinalizeDropCalldata does not reproduce"));
  transaction(drop.safeCreateDropTransaction, at("safeCreateDropTransaction"), asset.distributorAddress, createCalldata);
  transaction(drop.safeFinalizeDropTransaction, at("safeFinalizeDropTransaction"), asset.distributorAddress, finalizeCalldata);
}

function validateCombinedDrop(drop, file) {
  const at = (field) => `${file}: ${field}`;
  validateAgainstSchema(combinedDropSchemaValidator, drop, file);
  assert(drop.schemaVersion === 4, at("schemaVersion must be 4"));
  assert(drop.chainId === 4663, at("chainId must be Robinhood Chain 4663"));
  bytes32(drop.dropId, at("dropId"));
  bytes32(drop.assetContextHash, at("assetContextHash"));
  bytes32(drop.allocationRoot, at("allocationRoot"));
  bytes32(drop.batchesRoot, at("batchesRoot"));

  const asset = drop.rewardAsset;
  address(asset.tokenAddress, at("rewardAsset.tokenAddress"));
  address(asset.distributorAddress, at("rewardAsset.distributorAddress"));
  const expectedAssetContextHash = keccak256(
    encodeAbiParameters(assetContextParameters, [
      4663n,
      asset.tokenAddress,
      asset.distributorAddress,
      drop.dropId,
    ]),
  );
  sameHex(drop.assetContextHash, expectedAssetContextHash, at("assetContextHash"));

  const rewardAmount = decimal(drop.rewardAmount, at("rewardAmount"));
  const holderRewardAmount = decimal(
    drop.funding.holderRewardAmount,
    at("funding.holderRewardAmount"),
  );
  const communityRewardAmount = decimal(
    drop.funding.communityRewardAmount,
    at("funding.communityRewardAmount"),
  );
  assert(
    holderRewardAmount + communityRewardAmount === rewardAmount,
    at("funding pools must sum to rewardAmount"),
  );
  if (drop.funding.mode === "shared_drop_bps") {
    const split = splitHolderCommunityBudget(rewardAmount, drop.funding.communityBps);
    assert(split.holderAmount === holderRewardAmount, at("holder basis-point split is wrong"));
    assert(
      split.communityAmount === communityRewardAmount,
      at("community basis-point split is wrong"),
    );
  } else {
    assert(drop.funding.mode === "separate_budget", at("funding mode is invalid"));
  }
  assert(
    decimal(drop.holderPool.rewardAmount, at("holderPool.rewardAmount")) === holderRewardAmount,
    at("holderPool reward amount does not match funding"),
  );
  assert(
    decimal(drop.communityPool.rewardAmount, at("communityPool.rewardAmount")) ===
      communityRewardAmount,
    at("communityPool reward amount does not match funding"),
  );

  const holderWindow = drop.window;
  const startBlock = decimal(holderWindow.startBlock, at("window.startBlock"));
  const endBlock = decimal(holderWindow.endBlock, at("window.endBlock"));
  assert(endBlock >= startBlock, at("holder window end must not precede its start"));
  assert(
    publishedRules.get(holderWindow.rulesPath) === holderWindow.rulesSha256,
    at("window rules hash does not match published bytes"),
  );

  const snapshotAddresses = new Set();
  const snapshotInputs = drop.holderPool.snapshot.map((holder, index) => {
    const prefix = at(`holderPool.snapshot[${index}]`);
    address(holder.address, `${prefix}.address`);
    const key = holder.address.toLowerCase();
    assert(!snapshotAddresses.has(key), `${prefix}.address is duplicated`);
    snapshotAddresses.add(key);
    if (index > 0) {
      assert(
        drop.holderPool.snapshot[index - 1].address.toLowerCase().localeCompare(key) < 0,
        at("holderPool.snapshot must be address-sorted"),
      );
    }
    return {
      address: holder.address,
      minimumBalance: decimal(holder.minimumBalance, `${prefix}.minimumBalance`),
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
  sameHex(drop.holderPool.snapshotHash, expectedSnapshotHash, at("holderPool.snapshotHash"));
  const holderAllocation = allocateHolderPool(
    holderRewardAmount,
    decimal(drop.holderPool.floorTokenAmount, at("holderPool.floorTokenAmount")),
    snapshotInputs,
  );
  assert(holderAllocation.undistributed === 0n, at("holder pool is not fully allocated"));
  assert(
    holderAllocation.eligibleCount === drop.holderPool.eligibleCount,
    at("holderPool.eligibleCount does not reproduce"),
  );
  assert(
    holderAllocation.totalWeight === decimal(drop.holderPool.totalWeight, at("holderPool.totalWeight")),
    at("holderPool.totalWeight does not reproduce"),
  );
  sameJson(
    drop.holderPool.allocations,
    holderAllocation.allocations.map((allocation) => ({
      address: allocation.address,
      minimumBalance: allocation.minimumBalance.toString(),
      streak: allocation.streak,
      multiplierBps: allocation.multiplierBps.toString(),
      weight: allocation.weight.toString(),
      amount: allocation.amount.toString(),
    })),
    at("holderPool.allocations"),
  );

  const score = drop.communityPool.score;
  assert(score.round.endTime >= score.round.startTime, at("community round timestamps are invalid"));
  assert(
    publishedRules.get(score.round.rulesPath) === score.round.rulesSha256,
    at("community rules hash does not match published bytes"),
  );
  const scoringRules = score.rules.map((rule, index) => {
    if (index > 0) {
      assert(score.rules[index - 1].action.localeCompare(rule.action) < 0, at("community rules must be action-sorted"));
    }
    assert(rule.perUtcDay <= rule.perRound, at(`community rule ${rule.action} has invalid caps`));
    return {
      action: rule.action,
      points: decimal(rule.points, at(`community rule ${rule.action}.points`)),
      perUtcDay: rule.perUtcDay,
      perRound: rule.perRound,
    };
  });
  const approvedEvents = score.approvedEvents.map((event, index) => {
    bytes32(event.eventCommitment, at(`community approvedEvents[${index}].eventCommitment`));
    assert(
      event.eventCommitment === event.eventCommitment.toLowerCase(),
      at(`community approvedEvents[${index}].eventCommitment must be lowercase`),
    );
    address(event.address, at(`community approvedEvents[${index}].address`));
    if (index > 0) {
      const previous = score.approvedEvents[index - 1];
      assert(
        previous.occurredAt < event.occurredAt ||
          (previous.occurredAt === event.occurredAt &&
            previous.eventCommitment.localeCompare(event.eventCommitment) < 0),
        at("community approvedEvents must be time-and-commitment sorted"),
      );
    }
    return event;
  });
  const excluded = new Set();
  score.excludedAddresses.forEach((candidate, index) => {
    address(candidate, at(`community excludedAddresses[${index}]`));
    const key = candidate.toLowerCase();
    assert(!excluded.has(key), at(`community excludedAddresses[${index}] is duplicated`));
    if (index > 0) {
      assert(
        score.excludedAddresses[index - 1].toLowerCase().localeCompare(key) < 0,
        at("community excludedAddresses must be address-sorted"),
      );
    }
    excluded.add(key);
  });
  const recomputedScore = scoreCommunityContributions({
    startTime: score.round.startTime,
    endTime: score.round.endTime,
    rules: scoringRules,
    events: approvedEvents,
    excludedAddresses: excluded,
  });
  assert(recomputedScore.totalPoints > 0n, at("community score has no accepted points"));
  const committedInput = {
    round: {
      id: score.round.id,
      sequence: score.round.sequence,
      startTime: score.round.startTime,
      endTime: score.round.endTime,
      rulesVersion: score.round.rulesVersion,
      rulesPath: score.round.rulesPath,
      rulesSha256: score.round.rulesSha256,
    },
    rules: scoringRules.map((rule) => ({ ...rule, points: rule.points.toString() })),
    approvedEvents,
    excludedAddresses: score.excludedAddresses,
  };
  const inputCommitment = jsonCommitment(committedInput);
  sameHex(score.inputCommitment, inputCommitment, at("community score.inputCommitment"));
  const scoringResult = {
    contributors: recomputedScore.contributors.map((contributor) => ({
      address: contributor.address,
      points: contributor.points.toString(),
      acceptedEvents: contributor.acceptedEvents,
    })),
    acceptedEvents: recomputedScore.acceptedEvents.map((event) => ({
      eventCommitment: event.eventCommitment,
      address: event.address,
      action: event.action,
      occurredAt: event.occurredAt,
      points: event.points.toString(),
    })),
    rejectedEvents: recomputedScore.rejectedEvents.map((event) => ({
      eventCommitment: event.eventCommitment,
      address: event.address,
      action: event.action,
      occurredAt: event.occurredAt,
      reason: event.reason,
    })),
    totalPoints: recomputedScore.totalPoints.toString(),
  };
  sameJson(score.contributors, scoringResult.contributors, at("community score.contributors"));
  sameJson(score.acceptedEvents, scoringResult.acceptedEvents, at("community score.acceptedEvents"));
  sameJson(score.rejectedEvents, scoringResult.rejectedEvents, at("community score.rejectedEvents"));
  assert(score.totalPoints === scoringResult.totalPoints, at("community score.totalPoints does not reproduce"));
  const outputCommitment = jsonCommitment({ inputCommitment, result: scoringResult });
  sameHex(score.outputCommitment, outputCommitment, at("community score.outputCommitment"));

  const communityAllocation = allocateCommunityPool(
    communityRewardAmount,
    recomputedScore.contributors,
  );
  assert(communityAllocation.undistributed === 0n, at("community pool is not fully allocated"));
  assert(
    drop.communityPool.contributorCount === communityAllocation.contributorCount,
    at("communityPool.contributorCount does not reproduce"),
  );
  assert(
    decimal(drop.communityPool.totalPoints, at("communityPool.totalPoints")) ===
      communityAllocation.totalPoints,
    at("communityPool.totalPoints does not reproduce"),
  );
  sameJson(
    drop.communityPool.allocations,
    communityAllocation.allocations.map((allocation) => ({
      address: allocation.address,
      points: allocation.points.toString(),
      acceptedEvents: allocation.acceptedEvents,
      amount: allocation.amount.toString(),
    })),
    at("communityPool.allocations"),
  );

  const merged = mergeRewardAllocations(
    holderAllocation.allocations.map(({ address: recipient, amount }) => ({ address: recipient, amount })),
    communityAllocation.allocations.map(({ address: recipient, amount }) => ({ address: recipient, amount })),
  );
  assert(merged.totalAmount === rewardAmount, at("merged allocations do not equal rewardAmount"));
  assert(drop.recipientCount === merged.allocations.length, at("recipientCount does not reproduce"));
  const commitment = buildDistributionCommitment(drop.dropId, merged.allocations);
  sameHex(drop.allocationRoot, commitment.allocationRoot, at("allocationRoot"));
  sameHex(drop.batchesRoot, commitment.batchesRoot, at("batchesRoot"));
  const holderByAddress = new Map(
    holderAllocation.allocations.map((allocation) => [allocation.address.toLowerCase(), allocation.amount]),
  );
  const communityByAddress = new Map(
    communityAllocation.allocations.map((allocation) => [allocation.address.toLowerCase(), allocation.amount]),
  );
  sameJson(
    drop.allocations,
    merged.allocations.map((allocation, index) => ({
      address: allocation.address,
      holderAmount: (holderByAddress.get(allocation.address.toLowerCase()) ?? 0n).toString(),
      communityAmount: (communityByAddress.get(allocation.address.toLowerCase()) ?? 0n).toString(),
      amount: allocation.amount.toString(),
      leaf: commitment.entries[index].leaf,
      proof: commitment.entries[index].proof,
    })),
    at("allocations"),
  );

  assert(
    drop.expectedBatches === commitment.batches.length &&
      drop.batches.length === commitment.batches.length,
    at("expectedBatches does not reproduce"),
  );
  for (const [index, expected] of commitment.batches.entries()) {
    const operatorCalldata = encodeFunctionData({
      abi: distributorAbi,
      functionName: "distributeBatch",
      args: [drop.dropId, BigInt(index), expected.recipients, expected.amounts, expected.proof],
    });
    sameJson(
      drop.batches[index],
      {
        index,
        recipients: expected.recipients,
        amounts: expected.amounts.map(String),
        batchHash: expected.batchHash,
        leaf: expected.leaf,
        proof: expected.proof,
        operatorCalldata,
        operatorTransaction: { to: asset.distributorAddress, value: "0", data: operatorCalldata },
      },
      at(`batches[${index}]`),
    );
  }
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
  assert(drop.safeCreateDropCalldata.toLowerCase() === createDropCalldata.toLowerCase(), at("safeCreateDropCalldata does not reproduce"));
  assert(drop.safeFinalizeDropCalldata.toLowerCase() === finalizeDropCalldata.toLowerCase(), at("safeFinalizeDropCalldata does not reproduce"));
  transaction(drop.safeCreateDropTransaction, at("safeCreateDropTransaction"), asset.distributorAddress, createDropCalldata);
  transaction(drop.safeFinalizeDropTransaction, at("safeFinalizeDropTransaction"), asset.distributorAddress, finalizeDropCalldata);
}

function validateAnyDrop(drop, file) {
  if (drop?.schemaVersion === 7) return validateSurpriseDrop(drop, file);
  if (drop?.schemaVersion === 6) return validateStrictDiamondDrop(drop, file);
  if (drop?.schemaVersion === 5) return validateParticipationDrop(drop, file);
  if (drop?.schemaVersion === 4) return validateCombinedDrop(drop, file);
  return validateDrop(drop, file);
}

async function validateReconciliation(record, file, evidenceRoot = root) {
  const at = (field) => `${file}: ${field}`;
  validateAgainstSchema(reconciliationSchemaValidator, record, file);
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

  const dropsRoot = await realpath(resolve(evidenceRoot, "drops"));
  const artifactPath = await realpath(resolve(evidenceRoot, record.artifactPath));
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
  ajv.addSchema(schema);
  schemaCount += 1;
}
dropSchemaValidator = ajv.getSchema(dropSchemaId);
combinedDropSchemaValidator = ajv.getSchema(combinedDropSchemaId);
participationDropSchemaValidator = ajv.getSchema(participationDropSchemaId);
strictDiamondDropSchemaValidator = ajv.getSchema(strictDiamondDropSchemaId);
surpriseDropSchemaValidator = ajv.getSchema(surpriseDropSchemaId);
reconciliationSchemaValidator = ajv.getSchema(reconciliationSchemaId);
assert(dropSchemaValidator, `Missing schema ${dropSchemaId}`);
assert(combinedDropSchemaValidator, `Missing schema ${combinedDropSchemaId}`);
assert(participationDropSchemaValidator, `Missing schema ${participationDropSchemaId}`);
assert(strictDiamondDropSchemaValidator, `Missing schema ${strictDiamondDropSchemaId}`);
assert(surpriseDropSchemaValidator, `Missing schema ${surpriseDropSchemaId}`);
assert(reconciliationSchemaValidator, `Missing schema ${reconciliationSchemaId}`);
const deploymentCount = await validateProtocolDeployments();
publishedRules = await loadPublishedRules();

let dropFixtureCount = 0;
for (const path of await jsonFiles("fixtures/drops")) {
  validateAnyDrop(
    JSON.parse(await readFile(path, "utf8")),
    relative(root, path).replaceAll("\\", "/"),
  );
  dropFixtureCount += 1;
}
let reconciliationFixtureCount = 0;
for (const path of await jsonFiles("fixtures/reconciliations")) {
  await validateReconciliation(
    JSON.parse(await readFile(path, "utf8")),
    relative(root, path).replaceAll("\\", "/"),
    resolve(root, "fixtures"),
  );
  reconciliationFixtureCount += 1;
}

let dropCount = 0;
const dropIds = new Map();
for (const path of await jsonFiles("drops")) {
  const file = relative(root, path).replaceAll("\\", "/");
  const drop = JSON.parse(await readFile(path, "utf8"));
  validateAnyDrop(drop, file);
  const existing = dropIds.get(drop.dropId.toLowerCase());
  assert(!existing, `${file}: dropId is already published in ${existing}`);
  dropIds.set(drop.dropId.toLowerCase(), file);
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
  `Reproduced and validated ${schemaCount} evidence schemas, the pinned deployment schema, ${deploymentCount} canonical deployment manifests, ${dropFixtureCount} drop fixtures, ${reconciliationFixtureCount} reconciliation fixtures, ${dropCount} drops, and ${reconciliationCount} reconciliations.`,
);
