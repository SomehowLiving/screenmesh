#!/usr/bin/env node
/**
 * One-command version of docs/Android.md's acoustic PHY loopback check —
 * previously a manual recipe (compile, hand-write a Log.java stub,
 * javac it, then assemble a -cp by hand). Runs
 * com.dweekly.cyrinxhil.AcousticLoopbackTest.kt directly on the JVM,
 * driving the real AcousticPhyLink.encode()/ingest() DSP core through a
 * simulated noisy channel. See that file's doc comment for exactly what
 * this does and does not prove (no real microphone/speaker round trip).
 *
 * Requires JAVA_HOME already set (same as any other ./gradlew
 * invocation in this repo — see docs/Android.md's Setup section).
 *
 * Run from the repo root: node apps/android/scripts/run-acoustic-loopback-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ANDROID_DIR = path.join(REPO_ROOT, "apps", "android");
const GRADLEW = process.platform === "win32" ? "gradlew.bat" : "./gradlew";

const LOG_SHIM_SOURCE = `package android.util;

public final class Log {
    public static int v(String tag, String msg) { System.out.println("V/" + tag + ": " + msg); return 0; }
    public static int d(String tag, String msg) { System.out.println("D/" + tag + ": " + msg); return 0; }
    public static int i(String tag, String msg) { System.out.println("I/" + tag + ": " + msg); return 0; }
    public static int w(String tag, String msg) { System.out.println("W/" + tag + ": " + msg); return 0; }
    public static int e(String tag, String msg) { System.out.println("E/" + tag + ": " + msg); return 0; }
    public static int w(String tag, Throwable t) { System.out.println("W/" + tag + ": " + t); return 0; }
    public static int e(String tag, String msg, Throwable t) { System.out.println("E/" + tag + ": " + msg + " " + t); return 0; }
}
`;

function log(msg) {
  console.log(`[run-acoustic-loopback-test] ${msg}`);
}

function fail(msg) {
  console.error(`[run-acoustic-loopback-test] FAIL: ${msg}`);
  process.exitCode = 1;
}

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

async function main() {
  if (!process.env.JAVA_HOME) throw new Error("JAVA_HOME must be set (see docs/Android.md Setup)");
  const javaBin = path.join(process.env.JAVA_HOME, "bin", "java");
  const javacBin = path.join(process.env.JAVA_HOME, "bin", "javac");

  log("compiling the Android module and printing its plain-JVM runtime classpath...");
  const gradle = await run(
    path.join(ANDROID_DIR, GRADLEW),
    ["compileDebugKotlin", "printRuntimeClasspath", "--console=plain"],
    { cwd: ANDROID_DIR },
  );
  if (gradle.code !== 0) throw new Error(`gradle build failed with exit code ${gradle.code}`);

  const kotlinStdlib = gradle.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("CLASSPATH_ENTRY:"))
    .map((line) => line.slice("CLASSPATH_ENTRY:".length))
    .find((p) => /[\\/]kotlin-stdlib-[\d.]+\.jar$/.test(p) && !p.includes("kotlin-stdlib-jdk"));
  if (!kotlinStdlib) throw new Error("could not find kotlin-stdlib jar in the printed runtime classpath");

  const scratchDir = await mkdtemp(path.join(tmpdir(), "screenmesh-acoustic-"));
  try {
    // AcousticPhyLink calls android.util.Log directly; the real android.jar
    // stub throws "Stub!" on every call, so a minimal same-package
    // same-signature replacement ahead of it on the classpath is needed to
    // run this on a plain JVM — see AcousticLoopbackTest.kt's doc comment.
    const logShimDir = path.join(scratchDir, "android", "util");
    await import("node:fs/promises").then((fs) => fs.mkdir(logShimDir, { recursive: true }));
    const logShimSource = path.join(logShimDir, "Log.java");
    await writeFile(logShimSource, LOG_SHIM_SOURCE, "utf8");

    const logShimOut = path.join(scratchDir, "out");
    log("compiling the android.util.Log JVM test shim...");
    const javac = await run(javacBin, ["-d", logShimOut, logShimSource], { cwd: scratchDir });
    if (javac.code !== 0) throw new Error(`javac failed with exit code ${javac.code}`);

    const classesDir = path.join(ANDROID_DIR, "app", "build", "tmp", "kotlin-classes", "debug");
    const classpath = [logShimOut, classesDir, kotlinStdlib].join(path.delimiter);

    log("running the acoustic PHY loopback test...");
    const result = await run(javaBin, ["-cp", classpath, "com.dweekly.cyrinxhil.AcousticLoopbackTestKt"], {
      cwd: ANDROID_DIR,
    });

    if (result.code === 0 && result.stdout.includes("ACOUSTIC PHY LOOPBACK OK")) {
      log("PASS.");
    } else {
      fail(`exit code ${result.code}, output did not contain the expected OK marker`);
    }
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  fail(err.stack ?? String(err));
});
