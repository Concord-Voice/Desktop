export interface Server {
  id: string;
  name: string;
  icon_url?: string;
  owner_id: string;
  e2ee_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface ServerWithRole extends Server {
  role: 'owner' | 'admin' | 'member';
}

export interface CreateServerRequest {
  name: string;
  icon_url?: string;
  e2ee_default?: boolean;
}

export interface CreateServerResponse {
  server: Server;
  role: string;
}

export interface ListServersResponse {
  servers: ServerWithRole[];
}

// --- Invite Types ---

export interface ServerInvite {
  id: string;
  server_id: string;
  code: string;
  created_by: string;
  max_uses: number | null;
  use_count: number;
  expires_at: string | null;
  is_revoked: boolean;
  created_at: string;
}

export interface ServerInviteWithCreator extends ServerInvite {
  creator_username: string;
}

export interface CreateInviteRequest {
  max_uses?: number;
  expires_in?: number; // seconds
}

export interface JoinServerRequest {
  code: string;
}

export interface JoinServerResponse {
  server: Server;
  role: string;
}

export interface InviteInfoResponse {
  server_name: string;
  server_icon: string | null;
  member_count: number;
  valid: boolean;
}
