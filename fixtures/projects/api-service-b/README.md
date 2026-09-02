# Loomrail API service sample

A dependency-free in-memory issue service for trying a bounded Loomrail delivery workflow. Loomrail copies this
template into its own Git repository when you register the built-in sample. It never runs the service or its tests for
you.

Requires Node.js 24. Verify the baseline without an install or network step:

```sh
npm test
```

The sample intentionally exposes a pure HTTP-style handler rather than listening on a port. This keeps tests
deterministic and gives the workflow a small interface to extend. Choose one exact task from
[`SAMPLE-WORKFLOWS.md`](SAMPLE-WORKFLOWS.md).
