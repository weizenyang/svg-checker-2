import React, { useState, useEffect } from 'react';
import './object-list.css'

interface ObjectListProps {
}

const ObjectList: React.FC<ObjectListProps> = (props) => {
  const [eventData, setEventData] = useState<any>([]);
  const [csvEventData, setCsvEventData] = useState<any>([]);
  useEffect(() => {
    const handleFileUpload = (event: CustomEvent) => {
      setEventData(eventData => [...eventData, event.detail])
    };

    const handleCSVFileUpload = (event: CustomEvent) => {
      setCsvEventData(csvEventData =>[...csvEventData, event.detail])
    };


    // Adding the event listener
    window.addEventListener('file-upload', handleFileUpload as EventListener);

    // Adding the event listener
    window.addEventListener('file-upload-csv', handleCSVFileUpload as EventListener);

    return () => {
      window.removeEventListener('file-upload', handleFileUpload as EventListener);
    };
  }, []); // Empty dependency array means this effect runs only once on mount

  return (
    <ul className="item-list">
    {eventData.map((data, index) => {
        const matchedCsv = csvEventData.find(csvData => csvData.simplifiedName === data.unitName);
        return (
          <li className="item-list-item" key={`item-${index}`}>
            <p className="main-text">{data.unitName}</p>
            <p className="secondary-text">{data.fileName}</p>
            <p className="matched-csv">{matchedCsv ? matchedCsv.name : "none"}</p>
          </li>
        );
      })}
  </ul>
  );
}

export default ObjectList;