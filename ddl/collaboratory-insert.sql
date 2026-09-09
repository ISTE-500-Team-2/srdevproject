-- ISTE 501 - Team Arbor: Insert Script for Collaboratory Database

-- Sample data for user table
INSERT INTO "user" (userID, firstName, lastName, email, password, phone, status, statusDesc, registration_date) VALUES
(1, 'John', 'Doe', 'johndoe@example.com', 'johndoe', '123-456-7890', 'active', 'Active member', NOW()),
(2, 'Jane', 'Smith', 'janesmith@example.com', 'janesmith', '234-567-8901', 'active', 'Active member', NOW());

-- Sample data for membership_tiers table
INSERT INTO membership_tiers (tierID, tierName, tierPrice, allottedMonths) VALUES
(1, 'Basic Monthly', 19.99, 1),
(2, 'Basic Yearly', 99.99, 12),
(3, 'Premium Monthly', 29.99, 1),
(4, 'Premium Yearly', 149.99, 12),
(5, 'Student Monthly', 9.99, 1),
(6, 'Student Yearly', 49.99, 12);

-- Sample data for role table
INSERT INTO role (roleID, role, description) VALUES
(1, 'admin', 'Administrator'),
(2, 'member', 'Regular member'),
(3, 'student', 'Student member'),
(4, 'staff', 'Staff');

-- Sample data for equipment table
INSERT INTO equipment (equipmentID, name, status, waiverRequired) VALUES
(1, 'Welding Station', 'available', true),
(2, 'CNC Machine', 'available', true),
(3, '3D Printer', 'available', false);
