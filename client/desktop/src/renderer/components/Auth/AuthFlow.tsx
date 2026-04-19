import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ConnectionMode } from '../../types/auth';
import { useAuthStore } from '../../stores/authStore';
import { useUserStore, UserProfile } from '../../stores/userStore';
import { usePendingRegistrationStore } from '../../stores/pendingRegistrationStore';
import ConnectionSelector from './ConnectionSelector';
import ServerInput from './ServerInput';
import Register from './Register';
import Login from './Login';
import AccountRecovery from './AccountRecovery';
import EmailVerification from './EmailVerification';
import { ChangeEmail } from './ChangeEmail';
import './AuthFlow.css';

type AuthStep =
  | 'connection-select'
  | 'server-input'
  | 'hosted-register'
  | 'hosted-login'
  | 'self-hosted-auth'
  | 'email-verification'
  | 'change-email'
  | 'forgot-password';

const AuthFlow: React.FC = () => {
  const navigate = useNavigate();
  const accessToken = useAuthStore((state) => state.accessToken);
  const emailVerified = useAuthStore((state) => state.emailVerified);

  const hasPending = usePendingRegistrationStore((s) => s.pendingId !== null && !s.isExpired());

  // Derive initial step: pending registration resumes at email-verification,
  // otherwise a token without verified email goes to verification (login gate),
  // otherwise start at connection selection.
  const getInitialStep = (): AuthStep => {
    if (hasPending) return 'email-verification';
    if (accessToken && !emailVerified) return 'email-verification';
    return 'connection-select';
  };

  const [step, setStep] = useState<AuthStep>(getInitialStep);
  const [serverUrl, setServerUrl] = useState<string>('');

  // Watch for async verification state changes (e.g. session restore → /users/me fetch
  // flips emailVerified to false after mount). Transition to verification when needed.
  useEffect(() => {
    if (accessToken && !emailVerified) {
      setStep('email-verification');
    }
  }, [accessToken, emailVerified]);

  const handleConnectionSelect = (mode: ConnectionMode) => {
    if (mode === 'hosted') {
      setStep('hosted-register');
    } else if (mode === 'hosted-login') {
      setStep('hosted-login');
    } else {
      setStep('server-input');
    }
  };

  const handleServerConnect = (url: string) => {
    setServerUrl(url);
    setStep('self-hosted-auth');
    // Deferred: see #602 — requires self-hosted installer (#210)
    console.debug('Connecting to self-hosted server:', url);
  };

  const handleBack = () => {
    setStep('connection-select');
    setServerUrl('');
  };

  const handleRegistrationSuccess = (_data: { pendingId: string; email: string }) => {
    console.debug('Registration successful, pending email verification');
    setStep('email-verification');
  };

  const handleVerificationSuccess = () => {
    console.debug('Email verified, navigating to app');
    navigate('/app/dms');
  };

  const handleLoginSuccess = (data: {
    accessToken: string;
    user?: UserProfile;
    rememberMe: boolean;
  }) => {
    console.debug('Login successful, access token received');
    useAuthStore.getState().setAccessToken(data.accessToken);
    useAuthStore.getState().setRememberMe(data.rememberMe);
    if (data.user) {
      useUserStore.getState().setUser(data.user);

      // Gate unverified users behind email verification (same as registration)
      if (data.user.email_verified === false) {
        useAuthStore.getState().setEmailVerified(false);
        setStep('email-verification');
        return;
      }
    }
    useAuthStore.getState().setEmailVerified(true);
    navigate('/app/dms');
  };

  const handleSwitchToLogin = () => {
    setStep('hosted-login');
  };

  const handleSwitchToRegister = () => {
    setStep('hosted-register');
  };

  const handleForgotPassword = () => {
    setStep('forgot-password');
  };

  return (
    <div className="auth-flow">
      {step === 'connection-select' && (
        <div key="connection-select" className="auth-screen">
          <ConnectionSelector onSelect={handleConnectionSelect} />
        </div>
      )}

      {step === 'server-input' && (
        <div key="server-input" className="auth-screen">
          <ServerInput onConnect={handleServerConnect} onBack={handleBack} />
        </div>
      )}

      {step === 'hosted-register' && (
        <div key="hosted-register" className="auth-screen">
          <Register
            onBack={handleBack}
            onSuccess={handleRegistrationSuccess}
            onSwitchToLogin={handleSwitchToLogin}
          />
        </div>
      )}

      {step === 'hosted-login' && (
        <div key="hosted-login" className="auth-screen">
          <Login
            onBack={handleBack}
            onSuccess={handleLoginSuccess}
            onSwitchToRegister={handleSwitchToRegister}
            onForgotPassword={handleForgotPassword}
          />
        </div>
      )}

      {step === 'email-verification' && (
        <div key="email-verification" className="auth-screen">
          <EmailVerification
            maskEmail={false}
            onSuccess={handleVerificationSuccess}
            onChangeEmail={() => setStep('change-email')}
            onCancel={handleBack}
          />
        </div>
      )}

      {step === 'change-email' && (
        <div key="change-email" className="auth-screen">
          <ChangeEmail
            onDone={() => setStep('email-verification')}
            onCancel={() => setStep('email-verification')}
          />
        </div>
      )}

      {step === 'forgot-password' && (
        <div key="forgot-password" className="auth-screen">
          <AccountRecovery
            onBack={() => setStep('hosted-login')}
            onComplete={() => setStep('hosted-login')}
          />
        </div>
      )}

      {step === 'self-hosted-auth' && (
        <div className="auth-placeholder">
          <h2>Self-Hosted Auth</h2>
          <p>Connecting to: {serverUrl}</p>
          <p>Server&apos;s auth flow will be proxied here</p>
          <button onClick={handleBack}>← Back</button>
        </div>
      )}
    </div>
  );
};

export default AuthFlow;
