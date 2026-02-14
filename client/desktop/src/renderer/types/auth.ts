// Auth configuration types
export type ConnectionMode = 'hosted' | 'self-hosted';
export type AccountType = 'local' | 'bridged';

export interface ServerConnection {
  id: string;
  url: string;
  name: string;
  accountType: AccountType;
  profile?: UserProfile;
  tokens?: AuthTokens;
}

export interface UserProfile {
  id: string;
  username: string;
  email?: string;
  e2ee_preference: boolean;
  created_at: string;
}

export interface AuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  expires_at: number;
}

export interface AuthConfig {
  mode: ConnectionMode;
  primaryServer: string;
  servers: Map<string, ServerConnection>;
  currentServer: string;
}

export interface E2EEKeys {
  wrapped_private_key: string;
  key_derivation_salt: string;
  key_version: number;
}

export interface RegisterRequest {
  email: string;
  username: string;
  password: string;
  age_confirmation: boolean;
  wrapped_private_key: string;
  key_derivation_salt: string;
  e2ee_preference: boolean;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  expires_in: number;
  user: UserProfile;
  e2ee_keys: E2EEKeys;
}

export interface ServerInfo {
  name: string;
  version: string;
  features: string[];
  requires_approval: boolean;
  public: boolean;
}
