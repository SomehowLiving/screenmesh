#!/usr/bin/env node
/**
 * One-command version of docs/Android.md's "cross-language wire
 * compatibility" interop test — previously a manual, multi-step recipe
 * (start the relay, compile+print a classpath, hand-filter it down to
 * the plain-JVM jars, run the TS side, run the Kotlin side with the
 * assembled -cp). This orchestrates all of that and prints a single
 * PASS/FAIL. See packages/sync/scripts/interop-with-android.ts and
 * apps/android/app/src/main/java/com/screenmesh/InteropSmoke.kt for what
 * each side actually proves.
 *
 * Requires JAVA_HOME and ANDROID_HOME already set (same as any other
 * ./gradlew invocation in this repo — see docs/Android.md's Setup
 * section) and pnpm install already run at the repo root.
 *
 * Run from the repo root: node apps/android/scripts/run-interop-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ANDROID_DIR = path.join(REPO_ROOT, "apps", "android");
const GRADLEW = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
const HEALTH_URL = "http://127.0.0.1:8787/api/health";

function log(msg) {
  console.log(`[run-interop-test] ${msg}`);
}

function fail(msg) {
  console.error(`[run-interop-test] FAIL: ${msg}`);
  process.exitCode = 1;
}

/** Runs a command to completion, streaming its output, and resolves with (stdout, exit code). */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, shell: process.platform === "win32" });
    let stdout = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
      process.stdout.write(d);
    });
    child.stderr?.on("data", (d) => process.stderr.write(d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code }));
  });
}

/** Spawns a long-running background process; caller is responsible for killing it. */
function spawnBackground(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { ...opts, shell: process.platform === "win32" });
  child.stdout?.on("data", (d) => process.stdout.write(`[relay] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[relay] ${d}`));
  return child;
}

async function isHealthy(url) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(url)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`relay server never became healthy at ${url}`);
}

async function waitForFile(filePath, timeoutMs = 30_000) {
  const { existsSync } = await import("node:fs");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`handoff file never appeared at ${filePath} (did the TS side fail before writing it?)`);
}

async function main() {
  if (!process.env.JAVA_HOME) throw new Error("JAVA_HOME must be set (see docs/Android.md Setup)");
  if (!process.env.ANDROID_HOME) throw new Error("ANDROID_HOME must be set (see docs/Android.md Setup)");

  const handoffDir = await mkdtemp(path.join(tmpdir(), "screenmesh-interop-"));
  const handoffFile = path.join(handoffDir, "interop-handoff.json");

  let relay = null;
  if (await isHealthy(HEALTH_URL)) {
    log(`relay already running and healthy at ${HEALTH_URL} — reusing it instead of starting a second one.`);
  } else {
    log("starting relay server...");
    relay = spawnBackground(
      "pnpm",
      ["--filter", "@screenmesh/server", "exec", "tsx", "src/index.ts"],
      { cwd: REPO_ROOT },
    );
    await waitForHealth(HEALTH_URL);
    log("relay is up.");
  }

  try {

    log("compiling the Android module and printing its plain-JVM runtime classpath...");
    const gradle = await run(
      path.join(ANDROID_DIR, GRADLEW),
      ["compileDebugKotlin", "printRuntimeClasspath", "--console=plain"],
      { cwd: ANDROID_DIR },
    );
    if (gradle.code !== 0) throw new Error(`gradle build failed with exit code ${gradle.code}`);

    const jars = gradle.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("CLASSPATH_ENTRY:"))
      .map((line) => line.slice("CLASSPATH_ENTRY:".length))
      // Only .jar entries are usable directly on a plain `java -cp` — the
      // .aar entries (androidx/*) are Android-packaging-only and are never
      // touched by the plain-Kotlin protocol/crypto/transport/sync code
      // InteropSmoke.kt exercises. See docs/Android.md for how this was
      // first worked out by hand.
      .filter((p) => p.endsWith(".jar"));
    if (jars.length === 0) throw new Error("no .jar classpath entries found in gradle output");
    log(`resolved ${jars.length} runtime jars.`);

    const classesDir = path.join(ANDROID_DIR, "app", "build", "tmp", "kotlin-classes", "debug");
    const classpath = [classesDir, ...jars].join(path.delimiter);

    log("starting the TypeScript side (device A)...");
    const tsSide = run("pnpm", ["exec", "tsx", "packages/sync/scripts/interop-with-android.ts", handoffFile], {
      cwd: REPO_ROOT,
    });

    log("waiting for the TS side to create the workspace and write the handoff file...");
    await waitForFile(handoffFile);

    log("starting the Kotlin side (device B) on the JVM...");
    const kotlinSide = run("java", ["-cp", classpath, "com.screenmesh.InteropSmokeKt", handoffFile], {
      cwd: ANDROID_DIR,
    });

    const [tsResult, kotlinResult] = await Promise.all([tsSide, kotlinSide]);

    const tsOk = tsResult.code === 0 && tsResult.stdout.includes("ANDROID INTEROP OK");
    const kotlinOk = kotlinResult.code === 0 && kotlinResult.stdout.includes("KOTLIN INTEROP OK");

    if (tsOk && kotlinOk) {
      log("PASS: both sides confirmed interop.");
    } else {
      fail(`tsSide ok=${tsOk} (exit ${tsResult.code}), kotlinSide ok=${kotlinOk} (exit ${kotlinResult.code})`);
    }
  } finally {
    relay?.kill();
    await rm(handoffDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  fail(err.stack ?? String(err));
});
