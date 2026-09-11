-- ISTE 501 - Team Arbor: Insert Script for Collaboratory Database

-- Sample data for user table
INSERT INTO "user" (userID, firstName, lastName, email, password, phone, status, statusDesc, registration_date) VALUES
(1, 'John', 'Doe', 'johndoe@example.com', 'johndoe', '123-456-7890', 'active', 'Active member', NOW()),
(2, 'Jane', 'Smith', 'janesmith@example.com', 'janesmith', '234-567-8901', 'active', 'Active member', NOW()),
(3, 'Jonathan', 'Deen', 'JDeen1999@gmail.com', '1!J$$D!@', '(410) 490-3322', 'active', 'XX', TIMESTAMP '2026-09-11 00:00:00'),
(4, 'Mary', 'Ambrose', 'RoseyM@gmail.com', 'MaryLamb428', '(443) 972-1738', 'active', 'XX', TIMESTAMP '2026-09-11 00:00:00'),
(5, 'Mark', 'Barlow', 'MarkBar13@yahoo.com', 'mYp@ssw0rd111', '(410) 371-9425', 'inactive', 'banned for inappropriate behavior', TIMESTAMP '2026-09-11 00:00:00'),
(6, 'Katie', 'Cox', 'KatKat@yahoo.com', '123barry987', '(410) 822-5087', 'active', 'XX', TIMESTAMP '2026-09-11 00:00:00');

-- Sample data for membership_tiers table
INSERT INTO membership_tiers (tierID, tierName, tierPrice, allottedMonths) VALUES
(1, 'Basic Monthly', 19.99, 1),
(2, 'Basic Yearly', 99.99, 12),
(3, 'Premium Monthly', 29.99, 1),
(4, 'Premium Yearly', 149.99, 12),
(5, 'Student Monthly', 9.99, 1),
(6, 'Student Yearly', 49.99, 12),
(7, 'Monthly Membership', 15.99, 1),
(8, 'Yearly Membership', 99.99, 12);

-- Sample data for role table
INSERT INTO role (roleID, role, description) VALUES
(1, 'admin', 'Administrator'),
(2, 'member', 'Regular member'),
(3, 'student', 'Student member'),
(4, 'staff', 'Staff');

-- Sample data for permission table
INSERT INTO permission (permissionID, permissionName, description) VALUES
(1, 'create', 'Create a table record'),
(2, 'read', 'Read a table record'),
(3, 'update', 'Update a table record'),
(4, 'delete', 'Delete a table record');

-- Sample data for role_permission table
-- Admin: full CRUD on all tables.
INSERT INTO role_permission (rolePermissionID, roleID, permissionID, resourceName, scopeType, isAllowed) VALUES
(1, 1, 1, 'all_tables', 'global', TRUE),
(2, 1, 2, 'all_tables', 'global', TRUE),
(3, 1, 3, 'all_tables', 'global', TRUE),
(4, 1, 4, 'all_tables', 'global', TRUE);

-- Staff: read plus scoped operational writes; no RBAC-management or waiver/training write grant.
INSERT INTO role_permission (rolePermissionID, roleID, permissionID, resourceName, scopeType, isAllowed) VALUES
(5, 4, 2, 'all_tables', 'global', TRUE);

INSERT INTO role_permission (rolePermissionID, roleID, permissionID, resourceName, scopeType, isAllowed) VALUES
(9,4,1,'plan','global',TRUE),(10,4,3,'plan','global',TRUE),
(11,4,3,'user','global',TRUE),(12,4,3,'user_access','global',TRUE),
(13,4,1,'entitlement','global',TRUE),(14,4,3,'entitlement','global',TRUE),
(15,4,3,'payment','global',TRUE),(16,4,1,'reservation','global',TRUE),(17,4,3,'reservation','global',TRUE);

-- Member: read only their own table records (personal scope).
INSERT INTO role_permission (rolePermissionID, roleID, permissionID, resourceName, scopeType, isAllowed) VALUES
(7, 2, 2, 'all_tables', 'personal', TRUE);

-- Student: read only their own table records (personal scope).
INSERT INTO role_permission (rolePermissionID, roleID, permissionID, resourceName, scopeType, isAllowed) VALUES
(8, 3, 2, 'all_tables', 'personal', TRUE);

-- Sample data for user_role table
INSERT INTO user_role (rID, userID, roleID, assignedAt) VALUES
(1, 1, 1, NOW()),
(2, 2, 2, NOW());

-- Sample data for equipment table
INSERT INTO equipment (equipmentID, certID, name, status, waiverRequired) VALUES
(1, NULL, 'Welding Station', 'available', true),
(2, NULL, 'CNC Machine', 'available', true),
(3, NULL, '3D Printer', 'available', false),
(4, NULL, 'Rachel (3D printer)', 'available', false),
(5, NULL, 'Spock (Wood Lathe)', 'available', true),
(6, NULL, 'Kirk (Metal Lathe)', 'available', true),
(7, NULL, 'Joey (Large CNC)', 'available', true);

INSERT INTO certifications (certID, name, description, effectiveDate, endDate) VALUES
(1, 'Metal Lathe Certification', 'This certification verifies that the holder has successfully completed formal training in the safe and effective operation of a metal lathe.', TIMESTAMP '2026-09-11 00:00:00', TIMESTAMP '2027-09-11 00:00:00'),
(2, 'CNC Certification', 'This certification verifies that the holder has successfully completed formal training in the safe and effective operation of a CNC machine.', TIMESTAMP '2026-09-11 00:00:00', TIMESTAMP '2027-09-11 00:00:00');

INSERT INTO waiver (waiverID, name, version, description, effectiveDate) VALUES
(1, 'Metal Lathe Waiver', '1.0', 'This waiver acknowledges that the participant has been informed of, understands, and accepts the inherent risks associated with operating a metal lathe.', TIMESTAMP '2026-09-11 00:00:00'),
(2, 'CNC Waiver', '1.0', 'This waiver acknowledges that the participant has been informed of, understands, and accepts the inherent risks associated with operating a CNC machine.', TIMESTAMP '2026-09-11 00:00:00');

INSERT INTO guest (guestID, hostID, firstName, lastName, email, visitDate, status, statusDesc) VALUES
(1, 1, 'Jonathan', 'Deen', 'JDeen1999@gmail.com', TIMESTAMP '2026-08-23 00:00:00', 'active', 'XX'),
(2, 1, 'Mary', 'Ambrose', 'RoseyM@gmail.com', TIMESTAMP '2026-08-29 00:00:00', 'active', 'XX');