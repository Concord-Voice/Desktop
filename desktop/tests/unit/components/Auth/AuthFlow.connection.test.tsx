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
