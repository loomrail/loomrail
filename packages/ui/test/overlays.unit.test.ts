import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActionMenu } from "../src/overlays.js";

describe("ActionMenu", () => {
  it("leaves a trigger unchanged when there are no menu items", () => {
    const markup = renderToStaticMarkup(
      createElement(ActionMenu, {
        groups: [[]],
        trigger: createElement("button", { disabled: true, type: "button" }, "Move"),
      }),
    );

    expect(markup).toBe('<button disabled="" type="button">Move</button>');
  });
});
