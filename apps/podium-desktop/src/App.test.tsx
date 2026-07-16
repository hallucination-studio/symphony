import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { App } from "./App";

test("mounts the desktop scaffold", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "Symphony" })).toBeInTheDocument();
});
