function createTauriUi(platform, browser) {
  return Object.freeze({
    platform,
    async click(selector) {
      await (await browser.$(selector)).click();
    },
    async type(selector, value) {
      await (await browser.$(selector)).setValue(value);
    },
    async select(selector, value) {
      await (await browser.$(selector)).selectByVisibleText(value);
    },
    async read(selector) {
      return (await browser.$(selector)).getText();
    },
  });
}

export function createLinuxTauriUi({ browser }) {
  return createTauriUi("linux", browser);
}

export function createMacTauriUi({ browser }) {
  return createTauriUi("darwin", browser);
}
