/**
 * Provider Base Types
 *
 * Generic interfaces for the extensible provider system.
 * Used by both Sandbox and Agent providers.
 */

// ============================================================================
// Provider States
// ============================================================================

export type ProviderState =
  | "uninitialized"
  | "initializing"
  | "ready"
  | "error"
  | "stopping"
  | "stopped";

// ============================================================================
// Provider Events
// ============================================================================

export type ProviderEventType =
  | "registered"
  | "unregistered"
  | "initialized"
  | "started"
  | "stopped"
  | "error"
  | "state_changed"
  | "provider:registered"
  | "provider:unregistered"
  | "provider:initialized"
  | "provider:started"
  | "provider:stopped"
  | "provider:error"
  | "provider:switched";

export interface ProviderEvent {
  type: ProviderEventType | string;
  providerType: string;
  timestamp: number | Date;
  data?: unknown;
  error?: Error;
}

export type ProviderEventListener = (event: ProviderEvent) => void;

// ============================================================================
// Provider Capabilities
// ============================================================================

export interface ProviderCapabilities {
  /** Feature flags for this provider */
  [key: string]: boolean | string | string[] | undefined;
}

// ============================================================================
// Provider Metadata
// ============================================================================

export interface ProviderMetadata {
  /** Unique type identifier */
  type: string;
  /** Human-readable name */
  name: string;
  /** Description of the provider */
  description?: string;
  /** Version string */
  version?: string;
  /** Provider capabilities */
  capabilities?: ProviderCapabilities;
  /** Configuration schema for validation */
  configSchema?: Record<string, unknown>;
}

// ============================================================================
// Provider Configuration
// ============================================================================

export interface ProviderConfig {
  /** Provider type identifier */
  type: string;
  /** Human-readable name */
  name: string;
  /** Whether this provider is enabled */
  enabled: boolean;
  /** Provider-specific configuration */
  config: Record<string, unknown>;
}

export interface ProviderSelectionConfig {
  /** Category of provider */
  category: "sandbox" | "agent";
  /** Provider type identifier */
  type: string;
  /** Provider-specific configuration */
  config?: Record<string, unknown>;
}

export interface ProvidersConfig {
  /** Current sandbox provider selection */
  sandbox?: ProviderSelectionConfig;
  /** Current agent provider selection */
  agent?: ProviderSelectionConfig;
  /** Allow dynamic category access */
  [key: string]: ProviderSelectionConfig | undefined;
}

export interface ProviderSelection {
  /** Selected sandbox provider type */
  sandbox?: string;
  /** Selected agent provider type */
  agent?: string;
}

// ============================================================================
// Base Provider Interface
// ============================================================================

/**
 * Base interface for all providers (Sandbox, Agent, etc.)
 */
export interface IProvider {
  /** Provider type identifier */
  readonly type: string;
  /** Human-readable provider name */
  readonly name: string;

  /**
   * Check if this provider is available on the current platform
   */
  isAvailable(): Promise<boolean>;

  /**
   * Initialize the provider with optional configuration
   */
  init(config?: Record<string, unknown>): Promise<void>;

  /**
   * Stop and cleanup the provider
   */
  stop(): Promise<void>;

  /**
   * Shutdown the provider (alias for stop)
   */
  shutdown(): Promise<void>;

  /**
   * Get the capabilities of this provider
   */
  getCapabilities(): ProviderCapabilities;
}

// ============================================================================
// Provider Instance
// ============================================================================

export interface ProviderInstance<TProvider extends IProvider = IProvider> {
  /** Provider instance */
  provider: TProvider;
  /** Current state */
  state: ProviderState;
  /** Configuration used to create this instance */
  config?: Record<string, unknown>;
  /** Error if state is 'error' */
  error?: Error;
  /** When this instance was created */
  createdAt?: Date;
  /** When this instance was last used */
  lastUsedAt?: Date;
}

// ============================================================================
// Provider Plugin
// ============================================================================

/**
 * Plugin definition for providers
 */
export interface ProviderPlugin<
  TProvider extends IProvider = IProvider,
  TConfig = Record<string, unknown>,
> {
  /** Plugin metadata */
  metadata: ProviderMetadata;
  /** Factory function to create provider instances */
  factory: (config?: TConfig) => TProvider;
  /** Optional initialization hook */
  onInit?: () => Promise<void>;
  /** Optional cleanup hook */
  onDestroy?: () => Promise<void>;
}

/**
 * Type guard to check if an object is a valid ProviderPlugin
 */
export function isProviderPlugin(obj: unknown): obj is ProviderPlugin {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }
  const plugin = obj as Record<string, unknown>;
  return (
    typeof plugin.metadata === "object" &&
    plugin.metadata !== null &&
    typeof (plugin.metadata as Record<string, unknown>).type === "string" &&
    typeof (plugin.metadata as Record<string, unknown>).name === "string" &&
    typeof plugin.factory === "function"
  );
}

// ============================================================================
// Provider Registry Interface
// ============================================================================

/**
 * Interface for provider registries
 */
export interface IProviderRegistry<
  TProvider extends IProvider = IProvider,
  TConfig = Record<string, unknown>,
> {
  /**
   * Register a provider plugin
   */
  register(plugin: ProviderPlugin<TProvider, TConfig>): void;

  /**
   * Unregister a provider by type
   */
  unregister(type: string): void;

  /**
   * Get a provider instance
   */
  getInstance(type: string, config?: TConfig): Promise<TProvider>;

  /**
   * Check if a provider type is registered
   */
  has(type: string): boolean;

  /**
   * Get all registered provider types
   */
  getRegistered(): string[];

  /**
   * Get available provider types (registered and available on platform)
   */
  getAvailable(): Promise<string[]>;

  /**
   * Get metadata for all registered providers
   */
  getAllMetadata(): ProviderMetadata[];

  /**
   * Stop all provider instances
   */
  stopAll(): Promise<void>;

  /**
   * Add event listener
   */
  on(listener: ProviderEventListener): () => void;

  /**
   * Remove event listener
   */
  off(listener: ProviderEventListener): void;
}

// ============================================================================
// Helper to define plugins
// ============================================================================

/**
 * Helper function to define a provider plugin with type inference
 */
export function defineProviderPlugin<
  TProvider extends IProvider = IProvider,
  TConfig = Record<string, unknown>,
>(
  plugin: ProviderPlugin<TProvider, TConfig>,
): ProviderPlugin<TProvider, TConfig> {
  return plugin;
}
