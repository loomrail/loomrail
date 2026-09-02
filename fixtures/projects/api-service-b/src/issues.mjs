const seedIssues = Object.freeze([
  Object.freeze({ id: "issue-1", title: "Review checkout boundary", severity: "high" }),
  Object.freeze({ id: "issue-2", title: "Polish empty state", severity: "low" }),
]);

export const listIssues = () => seedIssues.map((issue) => ({ ...issue }));

export const handleRequest = ({ method, path }) => {
  if (method === "GET" && path === "/health") {
    return { status: 200, body: { status: "ready" } };
  }
  if (method === "GET" && path === "/issues") {
    return { status: 200, body: { issues: listIssues() } };
  }
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Route not found" } } };
};
