declare module 'pino-roll' {
  import type { DestinationStream } from 'pino';
  interface Options {
    file: string | (() => string);
    size?: string | number;
    frequency?: string | number;
    extension?: string;
    limit?: { count?: number };
    mkdir?: boolean;
  }
  export default function pinoRoll(options: Options): Promise<DestinationStream>;
}
