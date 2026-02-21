-- Neon PostgreSQL Schema for Referral Program
-- Run this in Neon SQL Editor to create the tables

-- Users table
CREATE TABLE IF NOT EXISTS users (
    user_id SERIAL PRIMARY KEY,
    shopify_customer_id VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    email VARCHAR(255) NOT NULL UNIQUE,
    points INT DEFAULT 0,
    referral_code VARCHAR(50) UNIQUE,
    referred_by VARCHAR(50),
    last_discount_code VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    membership_status VARCHAR(100),
    vip_tier_name VARCHAR(100),
    date_of_birth DATE,
    referral_purchases_count INT DEFAULT 0,
    discount_code_id VARCHAR(100),
    referral_count INT DEFAULT 0,
    referal_discount_code VARCHAR(100)
);

-- User actions table
CREATE TABLE IF NOT EXISTS user_actions (
    action_id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(user_id),
    action_type VARCHAR(50) NOT NULL,
    points_awarded INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    action_ref VARCHAR(255)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
CREATE INDEX IF NOT EXISTS idx_user_actions_user_id ON user_actions(user_id);
