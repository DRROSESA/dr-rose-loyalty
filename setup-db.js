const mysql = require('mysql2/promise');

async function setup() {
  const db = await mysql.createConnection({
    host: 'auth-db1904.hstgr.io',
    user: 'u565452571_hassan',
    password: 'DrRose@2008R',
    database: 'u565452571_dr_rose_loyalt',
  });

  console.log('✅ متصل بقاعدة البيانات');

  await db.execute(`
    CREATE TABLE IF NOT EXISTS loyalty_customers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_number INT,
      name VARCHAR(255),
      phone VARCHAR(20) UNIQUE,
      city VARCHAR(100),
      visits INT DEFAULT 0,
      free_visits INT DEFAULT 0,
      status ENUM('normal','free_pending') DEFAULT 'normal',
      last_visit DATETIME,
      free_visit_earned_at DATETIME,
      cycle_start DATETIME,
      notification_msg TEXT,
      last_notification_sent TEXT,
      has_android TINYINT(1) DEFAULT 0,
      had_apple TINYINT(1) DEFAULT 0,
      revoked TINYINT(1) DEFAULT 0,
      revoke_reason TEXT,
      pass_updated_at DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✅ loyalty_customers');

  await db.execute(`
    CREATE TABLE IF NOT EXISTS wallet_devices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      device_id VARCHAR(255) UNIQUE,
      push_token VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✅ wallet_devices');

  await db.execute(`
    CREATE TABLE IF NOT EXISTS wallet_registrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      device_id VARCHAR(255),
      pass_serial VARCHAR(50),
      pass_type_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✅ wallet_registrations');

  await db.execute(`
    CREATE TABLE IF NOT EXISTS visit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT,
      visit_number INT,
      order_number VARCHAR(100),
      visited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✅ visit_logs');

  await db.execute(`
    CREATE TABLE IF NOT EXISTS notification_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255),
      message TEXT,
      recipients TEXT,
      sent_count INT DEFAULT 0,
      registered_count INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✅ notification_logs');

  await db.end();
  console.log('\n🎉 تم إنشاء كل الجداول بنجاح!');
}

setup().catch(err => {
  console.error('❌ خطأ:', err.message);
  process.exit(1);
});
