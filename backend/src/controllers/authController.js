import User from '../models/User.js';

function requireString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error(`${fieldName} is required.`);
    error.status = 400;
    throw error;
  }

  return value.trim();
}

function requireEmail(value) {
  const email = requireString(value, 'email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const error = new Error('email must be a valid email address.');
    error.status = 400;
    throw error;
  }
  return email;
}

function serializeUser(user) {
  return {
    _id: user._id,
    googleId: user.googleId,
    email: user.email,
    name: user.name,
    picture: user.picture,
    phone: user.phone,
    bloodGroup: user.bloodGroup,
    medicalNotes: user.medicalNotes,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export async function syncGoogleUserHandler(req, res) {
  const googleId = requireString(req.body.googleId, 'googleId');
  const email = requireEmail(req.body.email);
  const name = requireString(req.body.name, 'name');
  const picture = typeof req.body.picture === 'string' ? req.body.picture.trim() : undefined;

  const user = await User.findOneAndUpdate(
    { googleId },
    { $set: { email, name, picture } },
    {
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
      upsert: true,
    },
  );

  res.status(200).json({ user: serializeUser(user) });
}

export async function createGuestUserHandler(_req, res) {
  const guestId = `guest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const user = await User.create({
    googleId: guestId,
    email: `${guestId}@tether.app`,
    name: 'Guest User',
  });

  res.status(201).json({ user: serializeUser(user) });
}
