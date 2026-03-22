import React, { useState, useEffect, useRef } from 'react';
import { useUserStore, UpdateProfileData } from '../../stores/userStore';
import LoadingSpinner from '../Auth/LoadingSpinner';
import Modal from '../ui/Modal';
import {
  MAX_AVATAR_SIZE,
  MAX_HEADER_SIZE,
  ALLOWED_TYPES,
  USERNAME_MIN,
  USERNAME_MAX,
  DISPLAY_NAME_MAX,
  BIO_MAX,
  MAX_LINKS,
  type ProfileFormErrors,
} from './profileConstants';

const ProfileInfoForm: React.FC = () => {
  const user = useUserStore((state) => state.user);
  const updateProfile = useUserStore((state) => state.updateProfile);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const headerFileInputRef = useRef<HTMLInputElement>(null);

  // Profile form state
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(null);
  const [avatarRemoved, setAvatarRemoved] = useState(false);
  const [headerPreview, setHeaderPreview] = useState<string | null>(null);
  const [headerDataUrl, setHeaderDataUrl] = useState<string | null>(null);
  const [headerRemoved, setHeaderRemoved] = useState(false);
  const [links, setLinks] = useState<string[]>([]);
  const [profileErrors, setProfileErrors] = useState<ProfileFormErrors>({});
  const [isProfileSubmitting, setIsProfileSubmitting] = useState(false);
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null);
  const [showUsernameConfirm, setShowUsernameConfirm] = useState(false);

  // Username change cooldown
  const usernameChangeEligibleAt = user?.username_change_eligible_at
    ? new Date(user.username_change_eligible_at)
    : null;
  const isUsernameOnCooldown = usernameChangeEligibleAt
    ? usernameChangeEligibleAt > new Date()
    : false;

  // Initialize form from user store
  useEffect(() => {
    if (user) {
      setUsername(user.username);
      setDisplayName(user.display_name || '');
      setBio(user.bio || '');
      setAvatarPreview(user.avatar_url || null);
      setAvatarDataUrl(user.avatar_url || null);
      setAvatarRemoved(false);
      setHeaderPreview(user.header_image_url || null);
      setHeaderDataUrl(user.header_image_url || null);
      setHeaderRemoved(false);
      setLinks(user.links || []);
    }
  }, [user]);

  // Avatar handlers
  const handleAvatarClick = () => {
    fileInputRef.current?.click();
  };

  const handleAvatarKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleAvatarClick();
    }
  };

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!ALLOWED_TYPES.includes(file.type)) {
      setProfileErrors((prev) => ({
        ...prev,
        avatar: 'Only PNG, JPEG, GIF, and WebP images are allowed',
      }));
      return;
    }

    if (file.size > MAX_AVATAR_SIZE) {
      setProfileErrors((prev) => ({
        ...prev,
        avatar: 'Image must be smaller than 256KB',
      }));
      return;
    }

    setProfileErrors((prev) => ({ ...prev, avatar: undefined }));

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      setAvatarPreview(dataUrl);
      setAvatarDataUrl(dataUrl);
      setAvatarRemoved(false);
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveAvatar = () => {
    setAvatarPreview(null);
    setAvatarDataUrl(null);
    setAvatarRemoved(true);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Header image handlers
  const handleHeaderClick = () => {
    headerFileInputRef.current?.click();
  };

  const handleHeaderKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleHeaderClick();
    }
  };

  const handleHeaderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!ALLOWED_TYPES.includes(file.type)) {
      setProfileErrors((prev) => ({
        ...prev,
        header: 'Only PNG, JPEG, GIF, and WebP images are allowed',
      }));
      return;
    }

    if (file.size > MAX_HEADER_SIZE) {
      setProfileErrors((prev) => ({
        ...prev,
        header: 'Header image must be smaller than 512KB',
      }));
      return;
    }

    setProfileErrors((prev) => ({ ...prev, header: undefined }));

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      setHeaderPreview(dataUrl);
      setHeaderDataUrl(dataUrl);
      setHeaderRemoved(false);
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveHeader = () => {
    setHeaderPreview(null);
    setHeaderDataUrl(null);
    setHeaderRemoved(true);
    if (headerFileInputRef.current) headerFileInputRef.current.value = '';
  };

  // Link handlers
  const handleAddLink = () => {
    if (links.length < MAX_LINKS) {
      setLinks([...links, '']);
    }
  };

  const handleLinkChange = (index: number, value: string) => {
    const updated = [...links];
    updated[index] = value;
    setLinks(updated);
    // Clear error for this link
    if (profileErrors[`link_${index}`]) {
      setProfileErrors((prev) => ({ ...prev, [`link_${index}`]: undefined }));
    }
  };

  const handleRemoveLink = (index: number) => {
    setLinks(links.filter((_, i) => i !== index));
  };

  // Profile form validation
  const validateProfileForm = (): boolean => {
    const errors: ProfileFormErrors = {};

    const trimmedUsername = username.trim();
    if (!trimmedUsername) {
      errors.username = 'Username is required';
    } else if (trimmedUsername.length < USERNAME_MIN) {
      errors.username = `Username must be at least ${USERNAME_MIN} characters`;
    } else if (trimmedUsername.length > USERNAME_MAX) {
      errors.username = `Username must be at most ${USERNAME_MAX} characters`;
    } else if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$/.test(trimmedUsername)) {
      errors.username =
        'Letters, numbers, periods, underscores, and hyphens only. Must start and end with a letter or number.';
    } else if (/[._-]{2,}/.test(trimmedUsername)) {
      errors.username =
        'Username cannot contain consecutive special characters (periods, underscores, hyphens).';
    }

    if (displayName.length > DISPLAY_NAME_MAX) {
      errors.displayName = `Display name must be at most ${DISPLAY_NAME_MAX} characters`;
    }

    if (bio.length > BIO_MAX) {
      errors.bio = `Bio must be at most ${BIO_MAX} characters`;
    }

    for (let i = 0; i < links.length; i++) {
      const link = links[i].trim();
      if (link && !link.startsWith('http://') && !link.startsWith('https://')) {
        errors[`link_${i}`] = 'Links must start with http:// or https://';
      }
    }

    setProfileErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Execute the profile update API call
  const doProfileUpdate = async () => {
    setIsProfileSubmitting(true);

    try {
      const updates: UpdateProfileData = {};

      if (username.trim().toLowerCase() !== user?.username) {
        updates.username = username.trim();
      }
      if (displayName !== (user?.display_name || '')) {
        updates.display_name = displayName.trim() || null;
      }
      if (bio !== (user?.bio || '')) {
        updates.bio = bio.trim() || null;
      }
      if (avatarRemoved) {
        updates.avatar_url = ''; // Empty string signals "remove" to backend
      } else if (avatarDataUrl && avatarDataUrl !== user?.avatar_url) {
        updates.avatar_url = avatarDataUrl;
      }
      if (headerRemoved) {
        updates.header_image_url = ''; // Empty string signals "remove" to backend
      } else if (headerDataUrl && headerDataUrl !== user?.header_image_url) {
        updates.header_image_url = headerDataUrl;
      }

      const filteredLinks = links.filter((l) => l.trim());
      const currentLinks = user?.links || [];
      if (JSON.stringify(filteredLinks) !== JSON.stringify(currentLinks)) {
        updates.links = filteredLinks;
      }

      if (Object.keys(updates).length === 0) {
        setProfileErrors({ general: 'No changes to save' });
        setIsProfileSubmitting(false);
        return;
      }

      await updateProfile(updates);
      setProfileSuccess('Profile updated successfully!');
      setAvatarRemoved(false);

      setTimeout(() => setProfileSuccess(null), 3000);
    } catch (error) {
      setProfileErrors({
        general: error instanceof Error ? error.message : 'Failed to update profile',
      });
    } finally {
      setIsProfileSubmitting(false);
    }
  };

  // Profile form submit — shows confirmation if username is changing
  const handleProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileErrors({});
    setProfileSuccess(null);

    if (!validateProfileForm()) return;

    // If username is changing, require explicit confirmation
    if (username.trim().toLowerCase() !== user?.username) {
      setShowUsernameConfirm(true);
      return;
    }

    await doProfileUpdate();
  };

  // Confirmed username change — proceed with the update
  const handleUsernameChangeConfirm = async () => {
    setShowUsernameConfirm(false);
    await doProfileUpdate();
  };

  // Check if profile form has unsaved changes
  const hasProfileChanges = (() => {
    if (!user) return false;
    if (username.trim() !== user.username) return true;
    if (displayName !== (user.display_name || '')) return true;
    if (bio !== (user.bio || '')) return true;
    if (avatarRemoved) return true;
    if (avatarDataUrl && avatarDataUrl !== user.avatar_url) return true;
    if (headerRemoved) return true;
    if (headerDataUrl && headerDataUrl !== user.header_image_url) return true;
    const filteredLinks = links.filter((l) => l.trim());
    const currentLinks = user.links || [];
    if (JSON.stringify(filteredLinks) !== JSON.stringify(currentLinks)) return true;
    return false;
  })();

  // Profile form cancel
  const handleProfileCancel = () => {
    if (user) {
      setUsername(user.username);
      setDisplayName(user.display_name || '');
      setBio(user.bio || '');
      setAvatarPreview(user.avatar_url || null);
      setAvatarDataUrl(user.avatar_url || null);
      setAvatarRemoved(false);
      setHeaderPreview(user.header_image_url || null);
      setHeaderDataUrl(user.header_image_url || null);
      setHeaderRemoved(false);
      setLinks(user.links || []);
      setProfileErrors({});
      setProfileSuccess(null);
    }
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  return (
    <form className="profile-section" onSubmit={handleProfileSubmit}>
      <h2 className="profile-section-title">Profile Information</h2>

      {/* Avatar */}
      <div className="profile-avatar-section">
        <div
          className="profile-avatar-upload"
          onClick={handleAvatarClick}
          onKeyDown={handleAvatarKeyDown}
          role="button"
          tabIndex={0}
          aria-label="Upload avatar"
        >
          {avatarPreview ? (
            <img src={avatarPreview} alt="Avatar preview" className="profile-avatar-preview" />
          ) : user ? (
            <span className="profile-avatar-initial">{user.username.charAt(0).toUpperCase()}</span>
          ) : (
            <div className="profile-avatar-placeholder">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path
                  d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              <span className="profile-avatar-placeholder-text">Upload</span>
            </div>
          )}
        </div>
        <div className="profile-avatar-actions">
          <span className="profile-avatar-actions-label">
            Click to upload an avatar (PNG, JPEG, GIF, WebP &mdash; max 256KB)
          </span>
          {avatarPreview && (
            <button
              type="button"
              className="profile-avatar-remove-btn"
              onClick={handleRemoveAvatar}
            >
              Remove avatar
            </button>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={handleAvatarChange}
          hidden
        />
      </div>
      {profileErrors.avatar && <span className="form-error">{profileErrors.avatar}</span>}

      {/* Header Image */}
      <div className="profile-header-image-section">
        <label className="form-label">Profile Banner</label>
        <div
          className="profile-header-upload"
          onClick={handleHeaderClick}
          onKeyDown={handleHeaderKeyDown}
          role="button"
          tabIndex={0}
          aria-label="Upload header image"
        >
          {headerPreview ? (
            <img src={headerPreview} alt="Header preview" className="profile-header-preview" />
          ) : (
            <div className="profile-header-placeholder">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path
                  d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              <span>Click to upload a banner image</span>
            </div>
          )}
        </div>
        <div className="profile-header-actions">
          <span className="profile-avatar-actions-label">
            PNG, JPEG, GIF, WebP &mdash; max 512KB. Recommended: 600&times;120 or wider.
          </span>
          {headerPreview && (
            <button
              type="button"
              className="profile-avatar-remove-btn"
              onClick={handleRemoveHeader}
            >
              Remove banner
            </button>
          )}
        </div>
        <input
          ref={headerFileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={handleHeaderChange}
          hidden
        />
      </div>
      {profileErrors.header && <span className="form-error">{profileErrors.header}</span>}

      {/* Username */}
      <div className="form-group">
        <label className="form-label">Username</label>
        <input
          type="text"
          className={`form-input ${profileErrors.username ? 'error' : ''}`}
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            if (profileErrors.username)
              setProfileErrors((prev) => ({ ...prev, username: undefined }));
          }}
          disabled={isProfileSubmitting || isUsernameOnCooldown}
          maxLength={USERNAME_MAX}
        />
        {profileErrors.username && <span className="form-error">{profileErrors.username}</span>}
        {isUsernameOnCooldown && usernameChangeEligibleAt ? (
          <span className="form-hint form-hint-warning">
            Username changes are limited to once per year. You can change it again on{' '}
            {formatDate(usernameChangeEligibleAt.toISOString())}.
          </span>
        ) : (
          <span className="form-hint">
            {username.trim().length}/{USERNAME_MAX} characters. Can be changed once per year.
          </span>
        )}
      </div>

      {/* Display Name */}
      <div className="form-group">
        <label className="form-label">Display Name</label>
        <input
          type="text"
          className={`form-input ${profileErrors.displayName ? 'error' : ''}`}
          placeholder="How you want to be displayed"
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
            if (profileErrors.displayName)
              setProfileErrors((prev) => ({ ...prev, displayName: undefined }));
          }}
          disabled={isProfileSubmitting}
          maxLength={DISPLAY_NAME_MAX}
        />
        {profileErrors.displayName && (
          <span className="form-error">{profileErrors.displayName}</span>
        )}
        <span className="form-hint">Optional</span>
      </div>

      {/* Bio */}
      <div className="form-group">
        <label className="form-label">About</label>
        <textarea
          className={`form-input profile-bio-textarea ${profileErrors.bio ? 'error' : ''}`}
          placeholder="Tell us a bit about yourself"
          value={bio}
          onChange={(e) => {
            setBio(e.target.value);
            if (profileErrors.bio) setProfileErrors((prev) => ({ ...prev, bio: undefined }));
          }}
          disabled={isProfileSubmitting}
          maxLength={BIO_MAX}
        />
        {profileErrors.bio && <span className="form-error">{profileErrors.bio}</span>}
        <span className="form-hint">
          {bio.length}/{BIO_MAX} characters
        </span>
      </div>

      {/* Links */}
      <div className="form-group">
        <label className="form-label">Links</label>
        <div className="profile-links-list">
          {links.map((link, index) => (
            <div key={index} className="profile-link-row">
              <input
                type="url"
                className={`form-input ${profileErrors[`link_${index}`] ? 'error' : ''}`}
                placeholder="https://example.com"
                value={link}
                onChange={(e) => handleLinkChange(index, e.target.value)}
                disabled={isProfileSubmitting}
              />
              <button
                type="button"
                className="profile-link-remove"
                onClick={() => handleRemoveLink(index)}
                disabled={isProfileSubmitting}
                aria-label="Remove link"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path
                    d="M10.5 3.5L3.5 10.5M3.5 3.5l7 7"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              {profileErrors[`link_${index}`] && (
                <span className="form-error" style={{ position: 'absolute' }}>
                  {profileErrors[`link_${index}`]}
                </span>
              )}
            </div>
          ))}
          {links.length < MAX_LINKS && (
            <button
              type="button"
              className="profile-link-add"
              onClick={handleAddLink}
              disabled={isProfileSubmitting}
            >
              + Add link
            </button>
          )}
        </div>
        <span className="form-hint">
          {links.length}/{MAX_LINKS} links
        </span>
      </div>

      {/* General Error */}
      {profileErrors.general && (
        <div className="form-error-banner">
          <span>{profileErrors.general}</span>
        </div>
      )}

      {/* Success Message */}
      {profileSuccess && (
        <div className="form-success-banner">
          <span>{profileSuccess}</span>
        </div>
      )}

      {/* Actions */}
      <div className="profile-actions">
        <button
          type="button"
          className="profile-cancel-btn"
          onClick={handleProfileCancel}
          disabled={isProfileSubmitting || !hasProfileChanges}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="profile-save-btn"
          disabled={isProfileSubmitting || !!profileSuccess}
        >
          {isProfileSubmitting ? (
            <>
              Saving...
              <LoadingSpinner size="small" inline />
            </>
          ) : (
            'Save Changes'
          )}
        </button>
      </div>

      {/* Member since */}
      {user?.created_at && (
        <div className="profile-member-since">Member since {formatDate(user.created_at)}</div>
      )}

      {/* Username change confirmation dialog */}
      <Modal
        isOpen={showUsernameConfirm}
        onClose={() => setShowUsernameConfirm(false)}
        title="Change Username"
        width="small"
      >
        <div className="username-change-confirm">
          <p>
            Are you sure you want to change your username from <strong>{user?.username}</strong> to{' '}
            <strong>{username.trim()}</strong>?
          </p>
          <p className="username-change-cooldown-notice">
            You will not be able to change your username again for 365 days.
          </p>
          <div className="username-change-actions">
            <button
              type="button"
              className="profile-cancel-btn"
              onClick={() => setShowUsernameConfirm(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="profile-save-btn"
              onClick={handleUsernameChangeConfirm}
            >
              Confirm Change
            </button>
          </div>
        </div>
      </Modal>
    </form>
  );
};

export default ProfileInfoForm;
