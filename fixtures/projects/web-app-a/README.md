# Loomrail web application sample

A dependency-free, server-rendered task list for trying a bounded Loomrail delivery workflow. Loomrail copies this
template into its own Git repository when you register the built-in sample. It never starts this application or runs
its tests for you.

Requires Node.js 24. Verify the untouched baseline without installing anything:

```sh
npm test
```

Run it explicitly on the loopback interface:

```sh
npm start
```

Then open `http://127.0.0.1:4173`. Set `LOOMRAIL_SAMPLE_PORT` before `npm start` to use another port. The process never
binds a non-loopback interface.

Choose one exact task from [`SAMPLE-WORKFLOWS.md`](SAMPLE-WORKFLOWS.md). The recipes are inputs to Loomrail's shipped
delivery workflow, not scripts and not extra workflow definitions.
