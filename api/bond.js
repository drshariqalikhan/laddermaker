// api/bonds.js
export default async function handler(req, res) {
  // Clear out cross-origin security rules cleanly
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');

  const { type, start, end, tenor } = req.query;
  
  const startDate = start || '2026-01-01';
  const endDate = end || '2026-12-31';
  
  let endpoint = '/bondsandbills/m/issuancecalendar';
  let filters = '';
  let sort = 'ann_date asc';

  if (type === 'tbills') {
    filters = `issue_type:"T" AND auction_tenor:"${tenor || 0.5}" AND ann_date:[${startDate} TO ${endDate}]`;
  } else if (type === 'savings') {
    endpoint = '/bondsandbills/m/savingbondsissuancecalendar';
    filters = `issue_type:"S" AND ann_date:[${startDate} TO ${endDate}]`;
  } else {
    filters = `issue_type:("B" OR "I" OR "G") AND ann_date:[${startDate} TO ${endDate}]`;
  }

  try {
    const baseUrl = 'https://mas.gov.sg';
    const finalUrl = `${baseUrl}${endpoint}?rows=5&filters=${encodeURIComponent(filters)}&sort=${encodeURIComponent(sort)}`;
    
    const masResponse = await fetch(finalUrl);
    if (!masResponse.ok) throw new Error(`MAS API responded with code: ${masResponse.status}`);
    
    const payload = await masResponse.json();
    return res.status(200).json(payload);

  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}
