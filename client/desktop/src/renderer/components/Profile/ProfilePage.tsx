import React from 'react';
import { useNavigate } from 'react-router-dom';
import ProfileInfoForm from './ProfileInfoForm';
import PasswordChangeForm from './PasswordChangeForm';
import './ProfilePage.css';

const ProfilePage: React.FC = () => {
  const navigate = useNavigate();

  return (
    <div className="view-container profile-fullpage">
      <div className="profile-page-content">
        <div className="profile-page-inner">
          {/* Back button */}
          <button className="profile-back-btn" onClick={() => navigate('/app')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M10 12L6 8l4-4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Back to app
          </button>

          <h1 className="profile-page-title">My Profile</h1>

          <ProfileInfoForm />
          <PasswordChangeForm />
        </div>
      </div>
    </div>
  );
};

export default ProfilePage;
