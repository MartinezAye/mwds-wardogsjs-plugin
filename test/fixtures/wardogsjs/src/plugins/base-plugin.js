export const logLines = [];

export default class BasePlugin {
  constructor(server, options, connectors = {}) {
    this.server = server;
    this.options = {};
    this.rawOptions = options ?? {};
    this.connectors = connectors;
    this.trackedListeners = [];

    for (const [optionName, option] of Object.entries(this.constructor.optionsSpecification)) {
      if (option.connector) {
        this.options[optionName] = connectors[this.rawOptions[optionName] ?? option.connector] ?? option.default ?? null;
        continue;
      }
      this.options[optionName] =
        typeof this.rawOptions[optionName] !== 'undefined' ? this.rawOptions[optionName] : option.default;
    }
  }

  static get description() {
    throw new Error('Plugin missing "static get description()" method.');
  }

  static get defaultEnabled() {
    throw new Error('Plugin missing "static get defaultEnabled()" method.');
  }

  static get optionsSpecification() {
    throw new Error('Plugin missing "static get optionsSpecification()" method.');
  }

  async prepareToMount() {}

  async mount() {}

  async unmount() {}

  on(event, handler) {
    this.server.on(event, handler);
    this.trackedListeners.push({ event, handler });
    return this;
  }

  off(event, handler) {
    this.server.off(event, handler);
    const index = this.trackedListeners.findIndex((entry) => entry.event === event && entry.handler === handler);
    if (index !== -1) this.trackedListeners.splice(index, 1);
    return this;
  }

  removeAllTrackedListeners() {
    for (const { event, handler } of this.trackedListeners) this.server.off(event, handler);
    this.trackedListeners = [];
  }

  verbose(level, message, ...extras) {
    logLines.push([level, `Server ${this.server?.id}: ${message}`, ...extras.map(String)].join(' '));
  }
}
