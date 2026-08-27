-- Collaboratory 

DROP TABLE IF EXISTS
    user,
    guest,
    check_in,
    day_pass,
    user_waiver,
    waiver,
    user_role,
    user_certifications,
    user_membership,
    certifications,
    role,
    reservation,
    payment,
    equipment,
    membership_tiers
CASCADE;

-- USER TABLE

CREATE TABLE IF NOT EXISTS user (
    userID INT PRIMARY KEY,
    firstName VARCHAR(50) NOT NULL,
    lastName VARCHAR(50) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    phone VARCHAR(15) NOT NULL,
    status VARCHAR(20),
    statusDesc VARCHAR(255),
    registration_date DATETIME
);

-- CHECK IN TABLE

CREATE TABLE IF NOT EXISTS check_in (
    checkInID INT PRIMARY KEY,
    userID INT,
    location VARCHAR(100) NOT NULL,
    checkInTime DATETIME NOT NULL,
    status VARCHAR(20),
    statusDesc VARCHAR(255),
    FOREIGN KEY (userID) REFERENCES user(userID)
);

-- USER MEMBERSHIP TABLE

CREATE TABLE IF NOT EXISTS user_membership (
    membershipID INT PRIMARY KEY,
    userID INT,
    tierID INT,
    startDate DATETIME NOT NULL,
    endDate DATETIME NOT NULL,
    status VARCHAR(20),
    statusDesc VARCHAR(255),
    FOREIGN KEY (userID) REFERENCES user(userID),
    FOREIGN KEY (tierID) REFERENCES membership_tiers(tierID)
);

-- MEMBERSHIP TIERS TABLE

CREATE TABLE IF NOT EXISTS membership_tiers (
    tierID INT PRIMARY KEY,
    tierName VARCHAR(50) NOT NULL,
    tierPrice DECIMAL(10, 2) NOT NULL,
    allottedMonths INT
);

-- PAYMENT TABLE

CREATE TABLE payment (
    paymentID INT PRIMARY KEY,
    membershipID INT,
    userID INT,
    price INT NOT NULL,
    paymentStatus VARCHAR(20),
    paymentDate DATETIME,
    autoRenewStatus BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (membershipID) REFERENCES user_membership(membershipID),
    FOREIGN KEY (userID) REFERENCES user(userID)
);

-- DAY PASS TABLE

CREATE TABLE day_pass (
    dayID INT PRIMARY KEY,
    userID INT,
    paymentID INT,
    validDate DATETIME,
    purchaseDate DATETIME,
    status VARCHAR(20),
    statusDesc VARCHAR(255),
    FOREIGN KEY (userID) REFERENCES user(userID),
    FOREIGN KEY (paymentID) REFERENCES payment(paymentID)
)

