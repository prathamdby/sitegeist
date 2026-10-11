import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import { join } from "node:path";

function read(path) {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return undefined;
	}
}

function snapshot(phase) {
	const group = read("/proc/self/cgroup")
		?.split("\n")
		.find((line) => line.startsWith("0::"))
		?.slice(3);
	const directories = group ? [join("/sys/fs/cgroup", group), "/sys/fs/cgroup"] : ["/sys/fs/cgroup"];
	const directory = directories.find((path) => read(join(path, "memory.current")) !== undefined);
	const resources = {
		time: new Date().toISOString(),
		phase,
		node: process.version,
		availableParallelism: availableParallelism(),
		systemMemoryBytes: totalmem(),
		freeSystemMemoryBytes: freemem(),
		systemMemory: read("/proc/meminfo")
			?.split("\n")
			.filter((line) => /^(MemAvailable|SwapTotal|SwapFree):/.test(line)),
		loadAverage: loadavg(),
		cgroup: directory
			? Object.fromEntries(
					[
						"memory.current",
						"memory.peak",
						"memory.max",
						"memory.events",
						"memory.stat",
						"cpu.max",
						"cpu.stat",
						"pids.current",
						"pids.max",
					].map((name) => [name, read(join(directory, name))]),
				)
			: null,
	};
	console.log(`[ci-resources] ${JSON.stringify(resources)}`);
	const processes = spawnSync("ps", ["-eo", "pid,ppid,rss,comm", "--sort=-rss"], {
		encoding: "utf8",
		timeout: 2000,
		maxBuffer: 256 * 1024,
	});
	if (processes.status === 0) console.log(processes.stdout.trim().split("\n").slice(0, 21).join("\n"));
	else console.log("[ci-resources] Process snapshot unavailable");
}

snapshot("start");
if (!process.argv.includes("--diagnostics-only")) {
	const child = spawn("npm", ["test"], { stdio: "inherit" });
	const interval = setInterval(() => snapshot("running"), 30000);
	const signals = new Map();
	let receivedSignal;
	for (const signal of ["SIGINT", "SIGTERM"]) {
		const handler = () => {
			receivedSignal = signal;
			snapshot(signal);
			child.kill(signal);
		};
		signals.set(signal, handler);
		process.on(signal, handler);
	}
	const finish = (code) => {
		clearInterval(interval);
		for (const [signal, handler] of signals) process.removeListener(signal, handler);
		snapshot("finish");
		process.exitCode = receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGTERM" ? 143 : code;
	};
	child.once("error", (error) => {
		console.error(`Unable to start migration tests: ${error.message}`);
		finish(1);
	});
	child.once("exit", (code, signal) => finish(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)));
}
