export interface RuntimeLogPublisherInterface {
  publish(input: {
    level: "info" | "warning" | "error";
    event: string;
    fields: Record<string, string>;
  }): void;
}
