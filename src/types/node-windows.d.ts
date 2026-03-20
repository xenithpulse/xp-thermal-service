declare module 'node-windows' {
  interface ServiceConfig {
    name: string;
    description?: string;
    script: string;
    env?: Array<{ name: string; value: string }>;
    nodeOptions?: string[];
    maxRestarts?: number;
    wait?: number;
    grow?: number;
    workingDirectory?: string;
  }

  export class Service {
    constructor(config: ServiceConfig);
    
    install(): void;
    uninstall(): void;
    start(): void;
    stop(): void;
    
    on(event: 'install' | 'alreadyinstalled' | 'uninstall' | 'alreadyuninstalled' | 'start' | 'stop' | 'error', listener: (arg?: any) => void): this;
  }
}
