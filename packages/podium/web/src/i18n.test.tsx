import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { I18nProvider, translate, useI18n } from "./i18n";

describe("i18n", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(navigator, "language", "get").mockReturnValue("zh-CN");
  });

  it("uses the browser language by default", () => {
    const { result } = renderHook(() => useI18n(), {
      wrapper: I18nProvider,
    });

    expect(result.current.locale).toBe("zh");
    expect(result.current.t("Sign in")).toBe("登录");
  });

  it("persists an explicit language choice", () => {
    const { result } = renderHook(() => useI18n(), {
      wrapper: I18nProvider,
    });

    act(() => result.current.setLocale("en"));

    expect(result.current.locale).toBe("en");
    expect(localStorage.getItem("podium.locale")).toBe("en");
    expect(result.current.t("Sign in")).toBe("Sign in");
  });

  it("falls back to the key when a translation is missing", () => {
    expect(translate("zh", "Unlisted phrase")).toBe("Unlisted phrase");
  });
});
