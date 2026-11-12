import type * as RuntimeServerBaseModule from '@/renderer/services/system/runtimeServerBase';
import { render, screen, fireEvent, waitFor } from '../../../test-utils';

const IDENTITY = {
  connectionId: 'AAAAAAAAAAAAAAAAAAAAAA',
  generation: 1,
  serviceId: 'saas',
  kind: 'saas',
  apiOrigin: 'https://api.example.com',
};

const runtimeMocks = vi.hoisted(() => ({
  setRuntimeServerBase: vi.fn(),
  resetRuntimeServerBase: vi.fn(),
}));
vi.mock('@/renderer/services/system/runtimeServerBase', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeServerBaseModule>()),
  setRuntimeServerBase: runtimeMocks.setRuntimeServerBase,
  resetRuntimeServerBase: runtimeMocks.resetRuntimeServerBase,
}));

vi.mock('@/renderer/services/system/clientConfigService', () => ({
  clientConfigService: { resetAndRefreshRuntimeServer: vi.fn(() => Promise.resolve()) },
}));

vi.mock('@/renderer/components/Auth/ConnectionSelector', () => ({
  default: ({ onSelect }: { onSelect: (mode: string) => void }) => (
    <button onClick={() => onSelect('self-hosted')}>Select Self-Hosted</button>
  ),
}));

vi.mock('@/renderer/components/Auth/ServerInput', () => ({
  default: ({ onConnect, onBack }: { onConnect: (url: string) => void; onBack: () => void }) => (
    <div data-testid="server-input">
      <button onClick={() => onConnect('https://my.server.com')}>Connect</button>
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));

vi.mock('@/renderer/components/Auth/Login', () => ({
  default: ({
    onBack,
    onSwitchToRegister,
  }: {
    onBack: () => void;
    onSwitchToRegister: () => void;
  }) => (
    <div data-testid="login">
      <button onClick={onSwitchToRegister}>Create Account</button>
      <button onClick={onBack}>Login Back</button>
    </div>
  ),
}));

vi.mock('@/renderer/components/Auth/Register', () => ({
  default: ({ onBack }: { onBack: () => void }) => (
    <div data-testid="register">
      <button onClick={onBack}>Register Back</button>
    </div>
  ),
}));

import AuthFlow from '@/renderer/components/Auth/AuthFlow';
import { _resetBootConnectionForTesting } from '@/renderer/services/system/bootConnection';

type ElectronBridge = { connection?: unknown };
const electron = () => window.electron as unknown as ElectronBridge;

async function openServerInput() {
  render(<AuthFlow />);
  fireEvent.click(screen.getByText('Select Self-Hosted'));
  await screen.findByTestId('server-input');
}

describe('AuthFlow in connection mode', () => {
  const create = vi.fn();
  const activate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    create.mockResolvedValue({ status: 'opened', serviceId: 'selfhost-0123456789abcdef' });
    activate.mockResolvedValue(true);
    electron().connection = { whoAmI: vi.fn(() => ({ ...IDENTITY })), create, activate };
    _resetBootConnectionForTesting();
  });

  afterEach(() => {
    delete electron().connection;
    _resetBootConnectionForTesting();
  });

  it('submit calls connection.create(url) and not setRuntimeServerBase', async () => {
    await openServerInput();

    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => expect(create).toHaveBeenCalledWith('https://my.server.com'));
    expect(runtimeMocks.setRuntimeServerBase).not.toHaveBeenCalled();
  });

  it("back calls connection.activate('saas') and not resetRuntimeServerBase", async () => {
    await openServerInput();

    fireEvent.click(screen.getByText('Back'));

    await waitFor(() => expect(activate).toHaveBeenCalledWith('saas'));
    expect(runtimeMocks.resetRuntimeServerBase).not.toHaveBeenCalled();
  });

  it('a saas document still lands Back on connection-select', async () => {
    await openServerInput();

    fireEvent.click(screen.getByText('Back'));

    expect(await screen.findByText('Select Self-Hosted')).toBeInTheDocument();
    expect(screen.queryByTestId('login')).not.toBeInTheDocument();
  });
});

// #86: a self-hosted document's API base is pinned to its own origin, so the
// connection selector's hosted sign-in and sign-up would run against it. Its home is
// its own login step, on boot and on every Back.
describe('AuthFlow in a self-hosted connection document', () => {
  const SELFHOST_IDENTITY = {
    connectionId: 'BBBBBBBBBBBBBBBBBBBBBB',
    generation: 1,
    serviceId: 'selfhost-0123456789abcdef',
    kind: 'selfhost',
    apiOrigin: 'https://my.server.com',
  };
  const create = vi.fn();
  const activate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    activate.mockResolvedValue(true);
    electron().connection = {
      whoAmI: vi.fn(() => ({ ...SELFHOST_IDENTITY })),
      create,
      activate,
    };
    _resetBootConnectionForTesting();
  });

  afterEach(() => {
    delete electron().connection;
    _resetBootConnectionForTesting();
  });

  it('boots on its own login step, not connection-select', () => {
    render(<AuthFlow />);

    expect(screen.getByTestId('login')).toBeInTheDocument();
    expect(screen.queryByText('Select Self-Hosted')).not.toBeInTheDocument();
  });

  it('Back leaves for saas and lands on its own login, not connection-select', async () => {
    render(<AuthFlow />);
    fireEvent.click(screen.getByText('Create Account'));
    await screen.findByTestId('register');

    fireEvent.click(screen.getByText('Register Back'));

    await waitFor(() => expect(activate).toHaveBeenCalledWith('saas'));
    expect(await screen.findByTestId('login')).toBeInTheDocument();
    expect(screen.queryByText('Select Self-Hosted')).not.toBeInTheDocument();
    expect(runtimeMocks.resetRuntimeServerBase).not.toHaveBeenCalled();
  });

  it('a refused activate is reported and still lands on its own login', async () => {
    activate.mockResolvedValue(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<AuthFlow />);

    fireEvent.click(screen.getByText('Login Back'));

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[AuthFlow] connection.activate refused')
    );
    expect(screen.getByTestId('login')).toBeInTheDocument();
    expect(screen.queryByText('Select Self-Hosted')).not.toBeInTheDocument();
    warn.mockRestore();
  });
});

describe('AuthFlow in legacy mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete electron().connection;
    _resetBootConnectionForTesting();
  });

  it('submit calls setRuntimeServerBase', async () => {
    await openServerInput();

    fireEvent.click(screen.getByText('Connect'));

    expect(runtimeMocks.setRuntimeServerBase).toHaveBeenCalledWith('https://my.server.com');
  });

  it('back calls resetRuntimeServerBase', async () => {
    await openServerInput();

    fireEvent.click(screen.getByText('Back'));

    expect(runtimeMocks.resetRuntimeServerBase).toHaveBeenCalled();
  });
});
