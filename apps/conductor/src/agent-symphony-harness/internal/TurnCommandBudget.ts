export class TurnCommandBudget {
  #brokerCalls = 0;
  #mutations = 0;

  constructor(private readonly limits: { maxBrokerCalls: number; maxMutations: number }) {
    if (!validLimit(limits.maxBrokerCalls) || !validLimit(limits.maxMutations)) {
      throw new Error("turn_command_budget_invalid");
    }
  }

  consumeCall() {
    if (this.#brokerCalls >= this.limits.maxBrokerCalls) return false;
    this.#brokerCalls += 1;
    return true;
  }

  consumeMutation() {
    if (this.#mutations >= this.limits.maxMutations) return false;
    this.#mutations += 1;
    return true;
  }

  usage() {
    return { broker_calls: this.#brokerCalls, mutations: this.#mutations };
  }
}

function validLimit(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}
