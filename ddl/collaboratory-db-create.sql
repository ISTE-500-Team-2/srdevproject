-- ISTE 501 - Team Arbor: Create Tables for Collaboratory Database

DROP TABLE IF EXISTS
    reservation,
    day_pass,
    payment,
    check_in,
    guest,
    user_waiver,
    user_certifications,
    user_role,
    user_membership,
    equipment,
    waiver,
    certifications,
    role,
    membership_tiers,
    "user"
CASCADE;

-- USER TABLE

CREATE TABLE "user" (
    userID INT PRIMARY KEY,
    firstName VARCHAR(50) NOT NULL,
    lastName VARCHAR(50) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    phone VARCHAR(15) NOT NULL,
    status VARCHAR(20),
    statusDesc VARCHAR(255),
    registration_date TIMESTAMP
);

-- MEMBERSHIP TIERS TABLE

CREATE TABLE membership_tiers (
    tierID INT PRIMARY KEY,
    tierName VARCHAR(50) NOT NULL,
    tierPrice DECIMAL(10, 2) NOT NULL,
    allottedMonths INT
);

-- USER MEMBERSHIP TABLE

CREATE TABLE user_membership (
    membershipID INT PRIMARY KEY,
    userID INT,
    tierID INT,
    startDate TIMESTAMP,
    end_date TIMESTAMP,
    status VARCHAR(20),
    statusDesc VARCHAR(255),
    FOREIGN KEY (userID) REFERENCES "user"(userID),
    FOREIGN KEY (tierID) REFERENCES membership_tiers(tierID)
);

-- PAYMENT TABLE

CREATE TABLE payment (
    paymentID INT PRIMARY KEY,
    membershipID INT,
    userID INT,
    price DECIMAL(10, 2) NOT NULL,
    paymentStatus VARCHAR(20),
    paymentDate TIMESTAMP,
    autoRenewStatus BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (membershipID) REFERENCES user_membership(membershipID),
    FOREIGN KEY (userID) REFERENCES "user"(userID)
);

-- DAY PASS TABLE

CREATE TABLE day_pass (
    dayID INT PRIMARY KEY,
    userID INT,
    paymentID INT,
    validDate TIMESTAMP,
    purchaseDate TIMESTAMP,
    status VARCHAR(20),
    statusDesc VARCHAR(255),
    FOREIGN KEY (userID) REFERENCES "user"(userID),
    FOREIGN KEY (paymentID) REFERENCES payment(paymentID)
);

-- CHECK IN TABLE

CREATE TABLE check_in (
    checkInID INT PRIMARY KEY,
    userID INT,
    location VARCHAR(100) NOT NULL,
    checkInTime TIMESTAMP NOT NULL,
    status VARCHAR(20),
    statusDesc VARCHAR(255),
    FOREIGN KEY (userID) REFERENCES "user"(userID)
);

-- GUEST TABLE

CREATE TABLE guest (
    guestID INT PRIMARY KEY,
    hostID INT,
    firstName VARCHAR(50) NOT NULL,
    lastName VARCHAR(50) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    visitDate TIMESTAMP NOT NULL,
    status VARCHAR(20),
    statusDesc VARCHAR(255),
    FOREIGN KEY (hostID) REFERENCES "user"(userID)
);

-- WAIVER TABLE

CREATE TABLE waiver (
    waiverID INT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    version VARCHAR(50) NOT NULL,
    description VARCHAR(255),
    effectiveDate TIMESTAMP
);

-- USER WAIVER TABLE

CREATE TABLE user_waiver (
    userWaiverID INT PRIMARY KEY,
    userID INT,
    waiverID INT,
    signDate TIMESTAMP,
    approval BOOLEAN,
    FOREIGN KEY (userID) REFERENCES "user"(userID),
    FOREIGN KEY (waiverID) REFERENCES waiver(waiverID)
);

-- CERTIFICATIONS TABLE

CREATE TABLE certifications (
    certID INT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(255),
    effectiveDate TIMESTAMP,
    endDate TIMESTAMP
);

-- USER CERTIFICATIONS TABLE

CREATE TABLE user_certifications (
    userCertID INT PRIMARY KEY,
    userID INT,
    certID INT,
    renewalDate TIMESTAMP,
    status VARCHAR(20),
    statusDesc VARCHAR(255),
    FOREIGN KEY (userID) REFERENCES "user"(userID),
    FOREIGN KEY (certID) REFERENCES certifications(certID),
    UNIQUE (userID, certID)
);

-- ROLE TABLE

CREATE TABLE role (
    roleID INT PRIMARY KEY,
    role VARCHAR(50) NOT NULL,
    description VARCHAR(255)
);

-- USER ROLE TABLE

CREATE TABLE user_role (
    rID INT PRIMARY KEY,
    userID INT,
    roleID INT,
    assignedAt TIMESTAMP,
    FOREIGN KEY (userID) REFERENCES "user"(userID),
    FOREIGN KEY (roleID) REFERENCES role(roleID)
);


-- EQUIPMENT TABLE

CREATE TABLE equipment (
    equipmentID INT PRIMARY KEY,
    certID INT,
    name VARCHAR(100) NOT NULL,
    status VARCHAR(20),
    waiverRequired BOOLEAN,
    FOREIGN KEY (certID) REFERENCES certifications(certID)
);


-- RESERVATION TABLE

CREATE TABLE reservation (
    reservationID INT PRIMARY KEY,
    userID INT,
    equipmentID INT,
    waiverID INT,
    location VARCHAR(100) NOT NULL,
    startTime TIMESTAMP NOT NULL,
    endTime TIMESTAMP NOT NULL,
    status VARCHAR(20),
    statusDesc VARCHAR(255),
    FOREIGN KEY (userID) REFERENCES "user"(userID),
    FOREIGN KEY (equipmentID) REFERENCES equipment(equipmentID),
    FOREIGN KEY (waiverID) REFERENCES waiver(waiverID)
);
