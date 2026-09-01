import process from "node:process";

process.stdout.write("x".repeat(1_048_577));
process.stdin.resume();
