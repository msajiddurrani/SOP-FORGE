CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    role VARCHAR(50) NOT NULL CHECK (role IN ('Employee', 'Manager', 'Executive', 'Admin')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sop_audit_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    user_role VARCHAR(50) NOT NULL,
    user_input TEXT NOT NULL,
    intent VARCHAR(64),
    department VARCHAR(64),
    is_authorized BOOLEAN,
    final_response TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

