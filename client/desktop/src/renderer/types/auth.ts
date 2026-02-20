// Auth configuration types
import type { UserProfile } from '../stores/userStore';
export type { UserProfile };

export type ConnectionMode = 'hosted' | 'hosted-login' | 'self-hosted';
export type AccountType = 'local' | 'bridged';

export interface ServerConnection {
  id: string;
  url: string;
  name: string;
  accountType: AccountType;
  profile?: UserProfile;
  tokens?: AuthTokens;
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
  remember_me?: boolean;
}

export interface LoginResponse {
  access_token: string;
  expires_in: number;
  remember_me: boolean;
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
