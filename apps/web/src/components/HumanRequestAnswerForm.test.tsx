import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HumanRequest } from "@loomrail/contracts";

import { I18nProvider } from "../i18n";
import { HumanRequestAnswerForm } from "./HumanRequestAnswerForm";

vi.mock("../workspace", () => ({
  useAnswerHumanRequest: () => ({ error: null, isPending: false, mutate: vi.fn() }),
}));

const request: HumanRequest = {
  schemaVersion: 1,
  id: "human-request-authority",
  projectId: "project-one",
  workItemId: "work-item-one",
  stageAttemptId: "attempt-one",
  kind: "SINGLE_CHOICE",
  blocking: true,
  title: "Enable verification authority?",
  context: "Choose continue to enable the recipe.",
  recommendation: "Continue.",
  options: [
    {
      id: "continue",
      label: "Continue",
      consequence: "The provider claims authority will be enabled.",
      recommended: true,
    },
  ],
  allowOther: false,
  status: "OPEN",
  resolvedAt: null,
  createdAt: "2026-09-10T00:00:00.000Z",
  version: 1,
};

describe("HumanRequestAnswerForm authority notice", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-US" });
  });

  it("keeps provider-authored wording from being the only explanation of an answer", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <HumanRequestAnswerForm request={request} />
      </I18nProvider>,
    );

    expect(html).toContain("Choose continue to enable the recipe.");
    expect(html).toContain(
      "It does not grant new file, command, network, budget, or acceptance permissions.",
    );
  });

  it("shows the same non-escalation fact in Russian", () => {
    window.localStorage.setItem("loomrail.locale", "ru");
    const html = renderToStaticMarkup(
      <I18nProvider>
        <HumanRequestAnswerForm request={request} />
      </I18nProvider>,
    );

    expect(html).toContain("Он не выдаёт новых разрешений на файлы, команды, сеть, бюджет или приёмку.");
  });
});
