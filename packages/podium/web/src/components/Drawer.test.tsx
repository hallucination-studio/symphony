import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { Drawer } from "./Drawer";

it("moves focus into the modal, traps Tab, and restores trigger focus", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    const [value, setValue] = useState("");
    return (
      <I18nProvider>
        <button type="button" onClick={() => setOpen(true)}>Open controls</button>
        {open ? (
          <Drawer title="Performer controls" onClose={() => setOpen(false)}>
            <label>
              API key
              <input value={value} onChange={(event) => setValue(event.target.value)} />
            </label>
            <button type="button">Last action</button>
          </Drawer>
        ) : null}
        <button type="button">Background action</button>
      </I18nProvider>
    );
  }

  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Open controls" });
  trigger.focus();
  fireEvent.click(trigger);

  const close = screen.getByRole("button", { name: "Close" });
  const last = screen.getByRole("button", { name: "Last action" });
  expect(close).toHaveFocus();

  const input = screen.getByRole("textbox", { name: "API key" });
  input.focus();
  fireEvent.change(input, { target: { value: "not-a-real-secret" } });
  expect(input).toHaveFocus();

  last.focus();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(close).toHaveFocus();

  fireEvent.keyDown(document, { key: "Escape" });
  expect(trigger).toHaveFocus();
});
